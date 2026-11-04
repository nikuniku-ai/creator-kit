# nikuniku.ai creator kit

[English](README.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md)

Tools for making videos with the [nikuniku.ai](https://studio.nikuniku.ai) `/v1` API from your own workbench:

| Path | What it is |
|---|---|
| `cli/nikuniku.mjs` | Command line: `nikuniku generate` uploads, checks, drafts, quotes, submits, waits and downloads in one step |
| `mcp/nikuniku-mcp.mjs` | MCP server (stdio) so Claude, Codex or any MCP client can price, submit and fetch jobs |
| `python/nikuniku_api.py` | Python client with no dependencies beyond the standard library |
| `skill/nikuniku-video/` | Claude skill describing the same flow |

## Start

1. Sign in at https://studio.nikuniku.ai/signin, create an API key and copy your workspace id.
2. Add credits at https://studio.nikuniku.ai/billing (1 credit = US$0.01; the quote is free).
3. Run:

```bash
npm install
export NIKUNIKU_API_KEY=...            # never paste it into a chat
node cli/nikuniku.mjs pricing
node cli/nikuniku.mjs generate --image ref.png --prompt examples/prompt.txt --max-credits 60 --wait --out shot.mp4
```

Python:

```python
import sys; sys.path.insert(0, "python")
from nikuniku_api import Client
c = Client.from_env()
ws = c.me()["workspace_id"]
c.generate(ws, open("examples/prompt.txt").read(), image="ref.png", max_credits=60, wait=True, out="shot.mp4")
```

MCP (Claude Code): `claude mcp add nikuniku -e NIKUNIKU_API_KEY=... -- node /path/to/mcp/nikuniku-mcp.mjs`

## What the service sells today

`GET https://api.nikuniku.ai/v1/capabilities` is the source of truth. On 2026-11-05 it lists release `h3`:
image-to-video, one reference image, 5083 ms. The clients already accept several `--image`, `--audio` and
`--continue-from`; they are used only when a release in that table supports them, otherwise the CLI exits 2 and names
what is missing.

## Tests

`npm test` runs against a local mock of `/v1` (no key, no credits). Full API reference: https://studio.nikuniku.ai/docs

See [SOURCE.md](SOURCE.md) for where this code comes from. No license file has been added yet.
