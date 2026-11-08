# Source

Exported from the private service repository `hanamizukikabukijou/nikuniku-ai` at `0f445e2a`
(production revision `0f445e2`, deployed 2026-11-08):

| Here | There |
|---|---|
| `cli/nikuniku.mjs`, `cli/publish-download.mjs` | `integrations/cli/` |
| `client/nikuniku-api.mjs` | `integrations/client/` |
| `mcp/nikuniku-mcp.mjs` | `integrations/mcp/` |
| `python/nikuniku_api.py` | `integrations/python/` |
| `skill/nikuniku-video/` | `integrations/skill/nikuniku-video/` |
| `examples/prompt.txt` | `integrations/examples/` |

Changes are made in the service repository first and merged here three-way, because `cli/` and `mcp/` also carry the director commands and tools; this repository adds only the README files,
`package.json`, the mock tests and CI.

The director workbench (`director/`, `schemas/`, `locales/`, `docs/director/`) is developed in this repository, not exported.
