# Source

Exported from the private service repository `hanamizukikabukijou/nikuniku-ai` at `71d0352f`
(production revision `2a35f68`, deployed 2026-11-05):

| Here | There |
|---|---|
| `cli/nikuniku.mjs`, `cli/publish-download.mjs` | `integrations/cli/` |
| `client/nikuniku-api.mjs` | `integrations/client/` |
| `mcp/nikuniku-mcp.mjs` | `integrations/mcp/` |
| `python/nikuniku_api.py` | `integrations/python/` |
| `skill/nikuniku-video/` | `integrations/skill/nikuniku-video/` |
| `examples/prompt.txt` | `integrations/examples/` |

Changes are made in the service repository first and exported again; this repository adds only the README files,
`package.json`, the mock tests and CI.

The director workbench (`director/`, `schemas/`, `locales/`, `docs/director/`) is developed in this repository, not exported.
