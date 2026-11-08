---
name: nikuniku-video
description: Generate a short image-to-video clip with the nikuniku.ai API — upload a reference image, save a draft, get a free quote, submit, wait and download. Use when the user asks to make a video with nikuniku, check their nikuniku credit balance or price a nikuniku generation.
---

# nikuniku.ai video generation

nikuniku.ai prepares and produces video through the same public API as the website. Read current capabilities before
promising a mode, reference count, duration or audio support. Public `/v1/pricing` describes retail packs; authenticated
`GET /v1/billing/channel?workspace_id=...` describes the workspace contract. Wholesale has no new recharge volume bonus
or new consumption referral rewards. Neither response replaces the generation quote and the user's approved ceiling.
The H3 single-reference commands below are examples, not proof that this release is currently available or qualified.

## Before you start

- The user signs in at https://studio.nikuniku.ai/signin and creates an API key there (shown once). Never ask for it in
  chat; read it from the environment.
- Credits are added by the user at https://studio.nikuniku.ai/billing. A quote is free; a submit reserves credits.
- Set these in the shell (the workspace id is shown next to the key):

```bash
export NIKUNIKU_API_BASE="${NIKUNIKU_API_BASE:-https://api.nikuniku.ai}"
export NIKUNIKU_API_KEY NIKUNIKU_WORKSPACE
```

Every response is `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message"}}`. Show the original error code.
The shared CLI/MCP client never retries HTTP requests automatically. Do not use a generic 429/5xx retry rule for writes:
a timeout, cancellation, unreadable response or server error can leave an accepted operation whose reply was lost.

- After an unknown generation submit, use `nikuniku_request_status` or `GET /v1/requests/{idempotency_key}?workspace_id=...`
  with the unchanged original key. With a known job, read that original job/output. `NOT_FOUND` remains unresolved;
  it does not authorize a new key, changed command or repeated submit. Preserve original workspace, actor and input.
- Drafting, uploads, saves, recipe runs, payments and cancellations have their own recovery contracts. A generation
  request lookup cannot recover those operations. Do not automatically re-upload, re-draft, cancel, refund or recharge.
- A caller may explicitly retry a read after 429/5xx with bounded waits and Retry-After, respecting its deadline and
  cancellation. Reads never authorize a write or additional spend. Keep unresolved state visible instead of looping.

## 1. Price and balance

```bash
curl -s "$NIKUNIKU_API_BASE/v1/pricing"
curl -s -H "authorization: Bearer $NIKUNIKU_API_KEY" "$NIKUNIKU_API_BASE/v1/wallet?workspace_id=$NIKUNIKU_WORKSPACE"
```

`available_units` is the spendable credit balance. Read `nikuniku_billing_channel` (or CLI `billing-channel --workspace <id>`)
before describing account benefits. Missing/failed contract reads mean UNKNOWN, not retail eligibility. Only the
server quote for the current qualified release determines the generation price; do not calculate it from a static rate.
Recharge uses the signed-in website. Do not send its session-only recharge endpoints a bearer API key or expose a
session/CSRF value in chat. The website binds confirmed channel/revision to the original order and restores unknown
orders; a changed-channel rejection requires a fresh explicit choice, never an automatic new order.

## 2. Upload the reference image

PNG only: 8-bit RGBA, non-interlaced, at most 512x512 and 1 MiB. Declare the exact size, then upload the bytes.
Convert any other image first: `ffmpeg -i in.jpg -vf "scale=512:512:force_original_aspect_ratio=decrease" -pix_fmt rgba ref.png`.
A refused upload names the fault (`IMAGE_TOO_LARGE`, `IMAGE_FORMAT_UNSUPPORTED`, `DECLARED_SIZE_MISMATCH`, with `error.details`)
and quarantines that asset, so fix the file and declare a new upload.
`rights_ref` names the user's right to use the image.

```bash
IMAGE=reference.png
SIZE=$(wc -c < "$IMAGE" | tr -d ' ')
ASSET=$(curl -s -X POST "$NIKUNIKU_API_BASE/v1/assets" -H "authorization: Bearer $NIKUNIKU_API_KEY" -H 'content-type: application/json' \
  -d "{\"workspace_id\":\"$NIKUNIKU_WORKSPACE\",\"declaration\":{\"idempotency_key\":\"ref-$SIZE-1\",\"declared_bytes\":$SIZE,\"mime\":\"image/png\",\"rights_ref\":\"user-owned\"}}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.asset_id')
curl -s -X PUT "$NIKUNIKU_API_BASE/v1/assets/$ASSET/content?workspace_id=$NIKUNIKU_WORKSPACE" -H "authorization: Bearer $NIKUNIKU_API_KEY" \
  -H 'content-type: image/png' --data-binary @"$IMAGE"
```

The upload answers `"state":"available"` when the image passed the checks.

## Write the prompt in H3's official format

For a currently offered `h3` single-reference release, the example uses MiniMax H3 in full-reference mode (Ref2VA) with one reference image. H3 follows its own prompt
structure much better than free text, so write the `prompt` field with MiniMax's official skill
[`h3-prompt-writing`](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing) (read its
`references/ref-en.txt` when available; do not install or modify another agent's configuration). For nikuniku:

- Mode is Ref2VA. The uploaded image is `<Picture 1>`; define it in `subject_definitions` before using it anywhere else.
- Six sections, in this order: `subject_definitions:`, `summary:`, `retention_analysis:`, `detailed_description:`,
  `overall_soundscape:`, `non_diegetic_music:`.
- `summary:` starts with the task type in brackets, normally `[reference generation]`.
- `detailed_description:` starts with `[Shot 1]` (no timestamp) and covers exactly 5 seconds: composition, subject,
  setting, action, camera, sound. Aim for 350-500 English words.
- Write in English; keep dialogue and on-screen text in the user's language.
- Show the user the plan (who, where, what happens, camera) and the quote before submitting; one submit is one 5-second shot.

You can write the prompt yourself, or let nikuniku's drafting model write it from the user's description in any language
(`POST /v1/prompts/draft` {workspace_id, description, idempotency_key}; MCP `nikuniku_draft_prompt`; CLI `compose`). It
may charge by token usage. Read the current drafting terms and obtain the item-specific ceiling first; never use it as free preparation.

Save the prompt as `prompt.txt` and check it before saving the draft (free; nothing is saved or charged). Do not go on while
`passed` is false: fix every entry in `errors` (this release sends one image, so only `<Picture 1>` exists — no `<Picture 2>`,
`<Audio N>` or `<Video N>`). `warnings` are norms and wording H3 is known to exaggerate (camera push-ins, blush, numeric
timecodes); the CLI `check` exits 3 when `passed` is false.

```bash
curl -s -X POST "$NIKUNIKU_API_BASE/v1/prompts/check" -H "authorization: Bearer $NIKUNIKU_API_KEY" -H 'content-type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({workspace_id:process.argv[1],mode:"image_to_video",prompt:require("fs").readFileSync("prompt.txt","utf8")}))' "$NIKUNIKU_WORKSPACE")"
```

## 3. Save a draft and get a quote

`price_version` must be the one from `/v1/pricing`; `duration_ms`, `mode` and the number of asset ids must match the h3 release
as `GET /v1/capabilities` lists it (no key needed; it also lists the image and prompt limits).
`project_revision` starts at 1 and goes up by one for each new draft of the same project.

```bash
PROJECT=clip-$(date +%s)
PRICE=$(curl -s "$NIKUNIKU_API_BASE/v1/pricing" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.price_version')
DRAFT=$(node -e 'const [ws,p,price,asset]=process.argv.slice(1);console.log(JSON.stringify(JSON.stringify({project:{schema_version:1,workspace_id:ws,project_id:p,project_revision:1,shot_revision:1,capabilities_revision:"h3",price_version:price,mode:"image_to_video",prompt:require("fs").readFileSync("prompt.txt","utf8"),duration_ms:5167,asset_ids:[asset]},character_source:"upload",reference_id:asset,scene:"A sunny park.",confirmed_revision:1})))' "$NIKUNIKU_WORKSPACE" "$PROJECT" "$PRICE" "$ASSET")
curl -s -X POST "$NIKUNIKU_API_BASE/v1/drafts" -H "authorization: Bearer $NIKUNIKU_API_KEY" -H 'content-type: application/json' \
  -d "{\"workspace_id\":\"$NIKUNIKU_WORKSPACE\",\"draft_json\":$DRAFT}"
QUOTE=$(curl -s -X POST "$NIKUNIKU_API_BASE/v1/quotes" -H "authorization: Bearer $NIKUNIKU_API_KEY" -H 'content-type: application/json' \
  -d "{\"workspace_id\":\"$NIKUNIKU_WORKSPACE\",\"project_id\":\"$PROJECT\"}")
echo "$QUOTE"
```

Tell the user `max_units` (credits) before submitting. The quote expires at `expires_at` (as returned by the API); quote again if
it has passed.

## 4. Submit, wait and download

Only submit after the user agreed to the quoted credits.

```bash
COMMAND=$(echo "$QUOTE" | node -pe 'const q=JSON.parse(require("fs").readFileSync(0)).data;JSON.stringify({quote_id:q.quote_id,acknowledged_input_hash:q.input_hash,user_acknowledged_max_units:q.max_units,idempotency_key:"job-"+q.quote_id.slice(2,34)})')
JOB=$(curl -s -X POST "$NIKUNIKU_API_BASE/v1/jobs" -H "authorization: Bearer $NIKUNIKU_API_KEY" -H 'content-type: application/json' \
  -d "{\"workspace_id\":\"$NIKUNIKU_WORKSPACE\",\"command\":$COMMAND}" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0));r.ok?r.data.job_id:(console.error(JSON.stringify(r)),"")')
[ -n "$JOB" ] || exit 1  # the refusal was printed above; nothing was reserved
curl -s -H "authorization: Bearer $NIKUNIKU_API_KEY" "$NIKUNIKU_API_BASE/v1/jobs/$JOB?workspace_id=$NIKUNIKU_WORKSPACE"
```

Poll the job every few seconds until `state` is `succeeded`, `failed` or `cancelled`. Then fetch the signed link (valid 5
minutes) and check the sha256 before handing the file over:

```bash
LINK=$(curl -s -H "authorization: Bearer $NIKUNIKU_API_KEY" "$NIKUNIKU_API_BASE/v1/jobs/$JOB/output?workspace_id=$NIKUNIKU_WORKSPACE")
URL=$(echo "$LINK" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.url')
SHA=$(echo "$LINK" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.sha256')
curl -s -o clip.mp4 "$URL" && echo "$SHA  clip.mp4" | shasum -a 256 -c
```

A failed job releases its reserved credits. `POST /v1/jobs/{job_id}/cancel` cancels a job that has not been delivered.

## MV-style shots: several identity images, a song, a continuation

Read `GET /v1/capabilities` first. A mode whose `audio` is `external` takes a song; `tail_continuation` continues a
delivered job; `references_max` says how many identity images it takes. When no sold release takes what you need, say
so to the user instead of dropping the song or the earlier shot.

- Upload the song: `POST /v1/audio` (declare WAV or MP3, at most 16 MiB and 10 minutes), then
  `PUT /v1/audio/{audio_id}/content?workspace_id=...` with the declared `Content-Type`. The answer carries `duration_ms`.
- In the draft, `asset_ids` lists every identity image (the first is also `reference_id`), `reference_audio_id` names the
  song and `continue_from_job_id` names the delivered job to continue. Leave out the fields you do not use.
- From the CLI in one step: `node integrations/cli/nikuniku.mjs generate --prompt prompt.txt --image a.png --image b.png
  --audio song.wav --continue-from <job_id> --max-credits 60 --wait --out shot2.mp4`. Without `--workspace` it uses the
  key's own workspace (`GET /v1/me`); it picks the sold mode that takes these inputs and refuses with `UNSUPPORTED`,
  before uploading anything, when none does.

## Tools instead of curl

- MCP server: `node integrations/mcp/nikuniku-mcp.mjs` (stdio) with `NIKUNIKU_API_KEY` set — tools `nikuniku_me`,
  `nikuniku_capabilities`, `nikuniku_pricing`, `nikuniku_draft_prompt`, `nikuniku_check_prompt`,
  `nikuniku_wallet`, `nikuniku_billing_channel`, `nikuniku_upload_png`, `nikuniku_upload_audio`, `nikuniku_save_draft`, `nikuniku_quote`,
  `nikuniku_submit`, `nikuniku_request_status`, `nikuniku_job_status`, `nikuniku_job_output`.
- CLI: `node integrations/cli/nikuniku.mjs help` — `upload`, `compose`, `check`, `draft`, `quote`, `submit`, `wait`, `download`.
- One step from the CLI: `node integrations/cli/nikuniku.mjs generate --workspace $NIKUNIKU_WORKSPACE --image ref.png --prompt prompt.txt --max-credits 60 --wait --out clip.mp4`. It uploads (dropping PNG metadata chunks), checks (exit 3 if the check fails), drafts, quotes, refuses above `--max-credits` (exit 4), submits, waits and downloads with a sha256 check; retain its original request identity and use original-request recovery after an unknown submit; do not rerun the whole upload/draft flow as a recovery shortcut.

The full contract is https://studio.nikuniku.ai/openapi.json.
