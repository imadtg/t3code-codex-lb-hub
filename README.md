# T3 Code codex-lb hub bridge

This small adapter exposes the CLIProxyAPI management endpoints used by T3
Code's Usage → Limits integration and reads account data from codex-lb's
API-key-authenticated `/api/proxy-management/accounts` endpoint.

Supported endpoints:

- `GET /v0/management/auth-files`
- `GET /v0/management/auth-files/models`
- `POST /v0/management/auth-files/refresh`
- `POST /v0/management/api-call` for Codex usage and reset credits
- `POST /v0/management/reset-quota`
- `GET /health`

The generic CLIProxyAPI `api-call` facility is deliberately limited to the
Codex endpoints above. It does not export codex-lb OAuth credentials or provide
arbitrary token-bearing HTTP forwarding.

## Run

The executable requires a management key and listens on loopback by default:

```sh
T3_CLB_HUB_MANAGEMENT_KEY='replace-me' t3code-codex-lb-hub
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `T3_CLB_HUB_MANAGEMENT_KEY` | required | Bearer or `X-Management-Key` credential |
| `T3_CLB_HUB_MANAGEMENT_KEY_FILE` | `~/.config/t3code-codex-lb-hub/management-key` | Read the credential from a file instead |
| `T3_CLB_HUB_HOST` | `127.0.0.1` | Listen address |
| `T3_CLB_HUB_PORT` | `8317` | Listen port |
| `T3_CLB_HUB_UPSTREAM` | `http://127.0.0.1:2455` | codex-lb base URL |
| `T3_CLB_HUB_UPSTREAM_API_KEY` | optional | Bearer credential for codex-lb |
| `T3_CLB_HUB_UPSTREAM_API_KEY_FILE` | `~/.config/codex-lb/client-api-key` | Read the codex-lb credential from a file instead |

Set either management-key variable. The environment value takes precedence;
the file form is recommended for long-running services.

When codex-lb API-key authentication is enabled, set either upstream API-key
variable. Its environment value also takes precedence over the file.

Keep the listener on loopback when exposing it through Tailscale Serve. In T3
Code, use the Serve URL and the same management key.

## Run from GitHub with Bun

Run the package directly without a checkout or global installation:

```sh
bunx --bun github:imadtg/t3code-codex-lb-hub#main
```

Bun caches the resolved Git package. Use a tag or commit after `#` when a
specific revision is required.

## Development

```sh
bun test
```
