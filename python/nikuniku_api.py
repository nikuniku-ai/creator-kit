"""Python client for the public nikuniku.ai /v1 API, standard library only.

The Python twin of integrations/client/nikuniku-api.mjs for workbenches written in Python (the MV director workbench is
one). Same rules: the base must be https (plain http only on a loopback host), the API key is a bearer token, requests are
never retried and redirects are never followed. An API error raises ApiError carrying the server's own code; anything
else raises Refusal with a stable code.

    c = Client.from_env()                      # NIKUNIKU_API_KEY, NIKUNIKU_API_BASE (default https://api.nikuniku.ai)
    r = c.generate(workspace, prompt, image='ref.png', max_credits=60, wait=True, out='clip.mp4')
    r = c.generate(None, prompt, image=['a.png', 'b.png'], audio='song.wav', continue_from=job_id)  # MV-style (E1)

workspace None means the key's own workspace (GET /v1/me).

generate stops before anything is charged when the prompt check fails or the quote is above max_credits. The project id
and every idempotency key derive from the inputs, so calling it again after a failure resumes the same job.
"""
import hashlib
import math
import json
import os
import re
import struct
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PNG = b'\x89PNG\r\n\x1a\n'
TERMINAL = {'succeeded', 'failed', 'cancelled'}
H3_DEFAULTS = {'release': 'h3', 'mode': 'image_to_video', 'duration_ms': 5083}
LOOPBACK = {'127.0.0.1', 'localhost', '::1'}
# The edge in front of api.nikuniku.ai refuses urllib's default User-Agent (HTTP 403, Cloudflare error 1010).
USER_AGENT = 'nikuniku-python/1.0'


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class ApiError(Exception):
    def __init__(self, body):
        error = body.get('error') or {}
        super().__init__(error.get('message', 'API error'))
        self.code = error.get('code')
        self.details = error.get('details')
        self.body = body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def strip_ancillary(data):
    """Drop ancillary chunks (lowercase first letter, e.g. pHYs from ffmpeg); they never change the pixels.

    Anything that is not a well-formed chunk sequence is returned unchanged and judged by the server."""
    if not data.startswith(PNG):
        return data
    keep, at = [data[:8]], 8
    while at + 12 <= len(data):
        n = struct.unpack('>I', data[at:at + 4])[0]
        if at + 12 + n > len(data):
            return data
        if not (97 <= data[at + 4] <= 122):
            keep.append(data[at:at + 12 + n])
        at += 12 + n
    return b''.join(keep) if at == len(data) else data


AUDIO_MAX_BYTES = 16777216


def audio_mime(data):
    """audio/wav for RIFF/WAVE, audio/mpeg for MPEG audio (optionally behind an ID3 tag), None otherwise."""
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WAVE':
        return 'audio/wav'
    if data[:3] == b'ID3' or (len(data) >= 2 and data[0] == 0xff and data[1] & 0xe0 == 0xe0):
        return 'audio/mpeg'
    return None


def pick_mode(table, images, audio, continue_from):
    """The sold mode that takes this many reference images, a song and a continuation, or None (same rule as the CLI)."""
    for r in (table or {}).get('releases') or []:
        for m in r.get('modes') or []:
            if ((m.get('audio') == 'external') == bool(audio) and (m.get('mode') == 'tail_continuation') == bool(continue_from)
                    and m.get('references_min', 0) <= images <= m.get('references_max', 0)):
                return {'release': r['alias'], 'mode': m['mode'], 'duration_ms': m['duration_ms']}
    return None


def _id(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}', value):
        raise Refusal('USAGE', name + ' is not a valid id')
    return value


def _wait_controls(timeout, poll_seconds):
    # Match the CLI's bounded timer domain. Booleans and non-finite numbers are not durations.
    if type(timeout) not in (int, float) or not 0 <= timeout <= 2147483.647 or not math.isfinite(timeout):
        raise Refusal('USAGE', 'timeout must be finite seconds from 0 to 2147483.647')
    if type(poll_seconds) not in (int, float) or not 0.001 <= poll_seconds <= 2147483.647 or not math.isfinite(poll_seconds):
        raise Refusal('USAGE', 'poll_seconds must be finite seconds from 0.001 to 2147483.647')


class Client:
    def __init__(self, base, key, timeout=30):
        url = urllib.parse.urlsplit(base or 'https://api.nikuniku.ai')
        self.loopback = url.hostname in LOOPBACK
        if (not (url.scheme == 'https' or (url.scheme == 'http' and self.loopback)) or url.username or url.password
                or url.query or url.fragment or url.path not in ('', '/')):
            raise Refusal('INVALID_BASE', 'NIKUNIKU_API_BASE must be https (plain http only on a loopback host)')
        if not isinstance(key, str) or not re.fullmatch(r'\S{8,512}', key):
            raise Refusal('API_KEY_REQUIRED', 'set NIKUNIKU_API_KEY to an API key from studio.nikuniku.ai')
        self.origin = url.scheme + '://' + url.netloc
        self.key = key
        self.timeout = timeout

    @classmethod
    def from_env(cls):
        return cls(os.environ.get('NIKUNIKU_API_BASE') or None, os.environ.get('NIKUNIKU_API_KEY', ''))

    def call(self, method, path, body=None, raw=None, auth=True):
        headers = {'Accept': 'application/json', 'User-Agent': USER_AGENT}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.key
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode()
        if raw is not None:
            headers['Content-Type'] = raw[1]
            data = raw[0]
        request = urllib.request.Request(self.origin + path, data=data, method=method, headers=headers)
        try:
            with _opener.open(request, timeout=self.timeout) as response:
                status, text = response.status, response.read()
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read()
        except (urllib.error.URLError, OSError):
            raise Refusal('NETWORK_ERROR', 'the API could not be reached')
        try:
            value = json.loads(text)
        except ValueError:
            raise Refusal('INVALID_RESPONSE', 'HTTP %d without a JSON body' % status)
        if 200 <= status < 300 and isinstance(value, dict) and value.get('ok') is True:
            return value['data']
        if isinstance(value, dict) and value.get('ok') is False and value.get('error'):
            raise ApiError(value)
        raise Refusal('INVALID_RESPONSE', 'HTTP %d with an unexpected body' % status)

    def _q(self, path, **query):
        return path + '?' + urllib.parse.urlencode(query)

    def capabilities(self):
        return self.call('GET', '/v1/capabilities', auth=False)

    def pricing(self):
        return self.call('GET', '/v1/pricing', auth=False)

    def wallet(self, workspace):
        return self.call('GET', self._q('/v1/wallet', workspace_id=workspace))

    def upload_png(self, workspace, path, rights='creator-owned'):
        """Declare the exact size, then PUT the bytes. The default key derives from the bytes, so a re-upload is a no-op."""
        with open(path, 'rb') as f:
            data = strip_ancillary(f.read())
        if not data.startswith(PNG) or len(data) > 1048576:
            raise Refusal('USAGE', 'the file must be a PNG of at most 1 MiB')
        key = 'png-' + hashlib.sha256(data).hexdigest()[:32]
        declared = self.call('POST', '/v1/assets', {'workspace_id': workspace, 'declaration': {
            'idempotency_key': key, 'declared_bytes': len(data), 'mime': 'image/png', 'rights_ref': _id(rights, 'rights')}})
        if declared['state'] == 'available':
            return declared
        return self.call('PUT', self._q('/v1/assets/%s/content' % urllib.parse.quote(declared['asset_id']),
                                        workspace_id=workspace), raw=(data, 'image/png'))

    def me(self):
        """The workspace and scopes of this API key."""
        return self.call('GET', '/v1/me')

    def upload_audio(self, workspace, path, rights='creator-owned'):
        """A song (WAV or MP3) for MV-style generation; the default key derives from the bytes, so a re-upload is a no-op."""
        with open(path, 'rb') as f:
            data = f.read()
        mime = audio_mime(data)
        if mime is None:
            raise Refusal('USAGE', 'the audio must be WAV or MP3; convert it first, e.g. ffmpeg -i in.m4a -ar 44100 -ac 2 song.wav')
        if len(data) > AUDIO_MAX_BYTES:
            raise Refusal('USAGE', 'the audio is %d bytes; the limit is 16 MiB; trim it or use MP3' % len(data))
        key = 'audio-' + hashlib.sha256(data).hexdigest()[:32]
        declared = self.call('POST', '/v1/audio', {'workspace_id': workspace, 'declaration': {
            'idempotency_key': key, 'declared_bytes': len(data), 'mime': mime, 'rights_ref': _id(rights, 'rights')}})
        if declared['state'] == 'available':
            return declared
        return self.call('PUT', self._q('/v1/audio/%s/content' % urllib.parse.quote(declared['audio_id']),
                                        workspace_id=workspace), raw=(data, mime))

    def check(self, workspace, prompt, mode='image_to_video'):
        return self.call('POST', '/v1/prompts/check', {'workspace_id': workspace, 'mode': mode, 'prompt': prompt})

    def job(self, workspace, job_id):
        return self.call('GET', self._q('/v1/jobs/%s' % urllib.parse.quote(job_id), workspace_id=workspace))

    def wait(self, workspace, job_id, timeout=1800, poll_seconds=5):
        _wait_controls(timeout, poll_seconds)
        deadline = time.monotonic() + timeout
        while True:
            state = self.job(workspace, job_id)
            if state['state'] in TERMINAL:
                return state
            if time.monotonic() + poll_seconds > deadline:
                raise Refusal('WAIT_TIMEOUT', 'job is still ' + state['state'])
            time.sleep(poll_seconds)

    def download(self, workspace, job_id, out):
        link = self.call('GET', self._q('/v1/jobs/%s/output' % urllib.parse.quote(job_id), workspace_id=workspace))
        url = urllib.parse.urlsplit(link['url'])
        same_loopback = self.loopback and url.scheme == 'http' and url.hostname == urllib.parse.urlsplit(self.origin).hostname
        if not (url.scheme == 'https' or same_loopback):
            raise Refusal('INVALID_RESPONSE', 'output link is not https')
        try:
            with _opener.open(urllib.request.Request(link['url'], headers={'User-Agent': USER_AGENT}), timeout=300) as response:
                if response.status != 200:
                    raise Refusal('DOWNLOAD_FAILED', 'output fetch answered HTTP %d' % response.status)
                data = response.read()
        except urllib.error.HTTPError as e:
            raise Refusal('DOWNLOAD_FAILED', 'output fetch answered HTTP %d' % e.code)
        except (urllib.error.URLError, OSError):
            raise Refusal('NETWORK_ERROR', 'the output could not be fetched')
        digest = hashlib.sha256(data).hexdigest()
        if digest != link['sha256']:
            raise Refusal('SHA256_MISMATCH', 'downloaded bytes do not match the output sha256; nothing was written')
        # Exclusive same-directory stage and no-overwrite publication; never touch a caller's .part path.
        target = os.path.abspath(out)
        parent = os.path.dirname(target)
        stage = None
        try:
            fd, stage = tempfile.mkstemp(prefix='.nikuniku-download-', dir=parent)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(stage, target)
            except FileExistsError:
                raise Refusal('DESTINATION_EXISTS', 'output already exists; choose a new file path')
            folder = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(folder)
            finally:
                os.close(folder)
        except OSError:
            raise Refusal('DOWNLOAD_WRITE_FAILED', 'output could not be published; inspect the original destination before retrying')
        finally:
            if stage is not None:
                os.unlink(stage)
        return {'output_id': link['output_id'], 'sha256': digest, 'bytes': len(data), 'file': out}

    def generate(self, workspace, prompt, image=None, mode=None, release=None, duration_ms=None, price_version=None, project=None,
                 rights='creator-owned', scene='As described in the prompt.', max_credits=None, wait=False, out=None,
                 timeout=1800, poll_seconds=5, audio=None, continue_from=None):
        """upload, check, draft, quote, refuse above max_credits, submit; then optionally wait and download.

        image may be one path or a list of up to 4 (identity images); audio adds a song; continue_from continues a delivered
        job. With any of those the release and mode are the sold ones that take them (Refusal UNSUPPORTED when none does)."""
        if wait:
            _wait_controls(timeout, poll_seconds)
        if max_credits is not None and (type(max_credits) is not int or not 0 <= max_credits <= 9007199254740991):
            raise Refusal('USAGE', 'max_credits must be a nonnegative safe whole number')
        images = [] if image is None else [image] if isinstance(image, str) else list(image)
        if len(images) > 4:
            raise Refusal('USAGE', 'at most 4 images')
        continue_from = _id(continue_from, 'continue_from') if continue_from is not None else None
        e1 = len(images) > 1 or audio is not None or continue_from is not None
        ws = _id(workspace if workspace is not None else self.me()['workspace_id'], 'workspace')
        spec, table = dict(H3_DEFAULTS), None
        try:
            table = self.capabilities()
            r = table['releases'][0]
            if not e1:
                spec = {'release': r['alias'], 'mode': r['modes'][0]['mode'], 'duration_ms': r['modes'][0]['duration_ms']}
        except (Refusal, ApiError, KeyError, IndexError, TypeError):
            pass
        if e1:
            picked = pick_mode(table, len(images), audio is not None, continue_from)
            if picked:
                spec = picked
            elif not (release and mode):
                raise Refusal('UNSUPPORTED', 'no sold release takes %d image(s)%s%s; see GET /v1/capabilities'
                              % (len(images), ', a song' if audio is not None else '', ', a continuation' if continue_from else ''))
        if release:
            spec['release'] = _id(release, 'release')
        if mode:
            spec['mode'] = _id(mode, 'mode')
        if duration_ms is not None:
            spec['duration_ms'] = int(duration_ms)
        price = price_version or self.pricing()['price_version']
        steps = {}
        assets = [self.upload_png(ws, path, rights)['asset_id'] for path in images]
        asset = assets[0] if assets else None
        if asset:
            steps['asset_id'] = asset
        if len(assets) > 1:
            steps['asset_ids'] = assets
        if not asset and spec['mode'] != 'text_to_video':
            raise Refusal('USAGE', 'image is required for ' + spec['mode'])
        audio_id = None
        if audio is not None:
            audio_id = self.upload_audio(ws, audio, rights)['audio_id']
            steps['audio_id'] = audio_id
        check = self.check(ws, prompt, spec['mode'])
        steps['check'] = check
        if check.get('passed') is False:
            raise ApiError({'ok': False, 'error': {'code': 'PROMPT_CHECK_FAILED', 'details': steps,
                                                   'message': 'the prompt check found errors; nothing was saved or charged'}})
        # Same digest input as the CLI (JSON.stringify of [ws, spec, price, asset, prompt]) so both resume each other's jobs.
        # The classic input is unchanged so earlier runs still resume; E1 inputs extend it exactly as the CLI does.
        key_input = [ws, spec, price, assets, prompt, audio_id, continue_from] if e1 else [ws, spec, price, asset, prompt]
        digest = hashlib.sha256(json.dumps(key_input, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        project = _id(project, 'project') if project else 'gen-' + digest[:24]
        draft = {'project': {'schema_version': 1, 'workspace_id': ws, 'project_id': project, 'project_revision': 1,
                             'shot_revision': 1, 'capabilities_revision': spec['release'], 'price_version': price,
                             'mode': spec['mode'], 'prompt': prompt, 'duration_ms': spec['duration_ms'],
                             'asset_ids': assets},
                 'character_source': 'upload' if asset else 'demo', 'reference_id': asset, 'scene': scene,
                 'confirmed_revision': 1}
        if audio_id:
            draft['reference_audio_id'] = audio_id
        if continue_from:
            draft['continue_from_job_id'] = continue_from
        steps['draft'] = self.call('POST', '/v1/drafts', {'workspace_id': ws, 'draft_json': json.dumps(draft)})
        steps['project_id'] = project
        quote = self.call('POST', '/v1/quotes', {'workspace_id': ws, 'project_id': project})
        steps['quote'] = {'quote_id': quote['quote_id'], 'max_units': quote['max_units'], 'unit_version': quote['unit_version']}
        if max_credits is not None and quote['max_units'] > max_credits:
            raise ApiError({'ok': False, 'error': {'code': 'ABOVE_MAX_CREDITS', 'details': steps,
                                                   'message': 'the quote is %d credits, above max_credits %d; nothing was charged'
                                                              % (quote['max_units'], max_credits)}})
        job = self.call('POST', '/v1/jobs', {'workspace_id': ws, 'command': {
            'quote_id': quote['quote_id'], 'acknowledged_input_hash': quote['input_hash'],
            'user_acknowledged_max_units': quote['max_units'], 'idempotency_key': 'gen-' + quote['input_hash'][:40]}})
        steps['job_id'] = job['job_id']
        if not wait:
            return steps
        steps['state'] = self.wait(ws, job['job_id'], timeout, poll_seconds)['state']
        if steps['state'] != 'succeeded':
            raise ApiError({'ok': False, 'error': {'code': 'JOB_NOT_SUCCEEDED', 'details': steps,
                                                   'message': 'job ended ' + steps['state']}})
        if out is not None:
            steps['download'] = self.download(ws, job['job_id'], out)
        return steps
