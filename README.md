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

The executable listens on loopback by default and creates a management key on
first start:

```sh
t3code-codex-lb-hub
cat ~/.config/t3code-codex-lb-hub/management-key
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `T3_CLB_HUB_MANAGEMENT_KEY` | generated | Override the Bearer or `X-Management-Key` credential |
| `T3_CLB_HUB_MANAGEMENT_KEY_FILE` | `~/.config/t3code-codex-lb-hub/management-key` | Persist the generated credential or read an existing one |
| `T3_CLB_HUB_HOST` | `127.0.0.1` | Listen address |
| `T3_CLB_HUB_PORT` | `8317` | Listen port |
| `T3_CLB_HUB_UPSTREAM` | `http://127.0.0.1:2455` | codex-lb base URL |
| `T3_CLB_HUB_UPSTREAM_API_KEY` | optional | Bearer credential for codex-lb |
| `T3_CLB_HUB_UPSTREAM_API_KEY_FILE` | `~/.config/codex-lb/client-api-key` | Read the codex-lb credential from a file instead |
| `T3_CLB_HUB_DASHBOARD_IDENTITY` | optional | Passwordless trusted-header identity for reset-credit operations |
| `T3_CLB_HUB_DASHBOARD_LOCAL_ADDRESS` | `127.0.0.2` | Dedicated loopback source address for dashboard requests |

The environment value takes precedence. Otherwise, the bridge reads the key
file or creates it atomically with mode `0600` when it does not exist.

When codex-lb API-key authentication is enabled, set either upstream API-key
variable. Its environment value also takes precedence over the file.

Keep the listener on loopback when exposing it through Tailscale Serve. In T3
Code, use the Serve URL and the same management key.

## Passwordless reset-credit access

Account summaries accept a proxy API key, but codex-lb's reset-credit routes
authenticate a dashboard account. Set `T3_CLB_HUB_DASHBOARD_IDENTITY=t3-hub`
to authenticate those requests with `X-T3-Hub-User: t3-hub` from a dedicated
loopback source. The hub retains its management-key authentication and its
account-scoped upstream API key. It never forwards caller-supplied identity
headers, exposes dashboard credentials, or grants arbitrary dashboard access.

This mode requires an HTTP IPv4 loopback upstream. Redirects are returned
without following them. The ordinary summary/model requests keep using the
upstream API key and do not carry a dashboard identity.

Configure codex-lb through its existing deployment environment:

```sh
CODEX_LB_DASHBOARD_AUTH_MODE=trusted_header
CODEX_LB_DASHBOARD_AUTH_PROXY_HEADER=X-T3-Hub-User
CODEX_LB_FIREWALL_TRUST_PROXY_HEADERS=true
CODEX_LB_FIREWALL_TRUSTED_PROXY_CIDRS=127.0.0.2/32
FORWARDED_ALLOW_IPS=
```

The empty `FORWARDED_ALLOW_IPS` is intentional: codex-lb must check the real
socket peer rather than a caller-supplied `X-Forwarded-For`. Do not trust
`127.0.0.1`, where a public reverse proxy such as Tailscale Serve connects.
This configuration treats processes on the hub machine as trusted; another
local process can also bind the dedicated address. It also makes codex-lb's
client-address logging and IP-based limits see the public gateway's loopback
address instead of individual forwarded client addresses.

Before starting the upgraded hub, use an existing admin dashboard session to:

1. Set the Reverse proxy provider's `unknownIdentityRoleId` to `null` and keep
   `linkByEmail` off. Unknown identities otherwise default to Admin.
2. Create a passwordless dashboard account for subject `t3-hub`, using the
   Operator preset for read/redeem access or Viewer for reads alone. Operator
   also grants general account, API-key and operational management; it is not
   a reset-only role. No password or TOTP secret is stored by the hub.

The provisioning APIs are `GET /api/dashboard-roles`,
`PATCH /api/auth-providers/{id}`, and `POST /api/dashboard-users`. For example,
the user-creation body is:

```json
{
  "username": "t3-hub",
  "roleId": "<operator role id from /api/dashboard-roles>",
  "ssoOnly": true,
  "expectedIdentity": {"provider": "trusted_header", "subject": "t3-hub"}
}
```

Provisioning requires a recently verified admin session, and trusted-header
mode must already be active when creating the passwordless account. Existing
password login remains available. The hub account can be disabled or demoted
through the dashboard to revoke or reduce its access.

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

To check the real codex-lb authentication and role enforcement using an
installed codex-lb Python environment:

```sh
CODEX_LB_PYTHON=/path/to/codex-lb/bin/python bun run check:codex-lb
```

This starts disposable upstream and hub listeners on random loopback ports.
It uses a temporary database, seeds two fake accounts with reset counts, and
replaces outbound redemption with a simulation. It checks identity spoofing,
account restrictions, Viewer permissions, revocation, and password-login
fallback without touching a running service, real account, or real reset.
