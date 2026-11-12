# google-ads-mcp

Read-only [Google Ads](https://ads.google.com) MCP server for [Claude.ai](https://claude.ai) remote connectors and scheduled tasks: an OAuth 2.1 proxy in Node.js in front of the official [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp) backend (PyPI `google-ads-mcp==0.0.6`), both in one Docker image.

## Why?

The official Google Ads MCP server is a stdio / HTTP server meant for local agents. To use it as a Claude.ai custom connector it needs OAuth 2.1, and for a reporting assistant it should not be able to change the account. This project adds both:

- **Read-only, enforced at startup**: only three query tools are exposed. Upstream's write tools are disabled in a baked-in config, and both the backend and the proxy refuse to start if the tool set is anything else.
- **OAuth 2.1 without dynamic client registration**: one fixed client whose `client_id` / `client_secret` are derived from `MCP_SECRET` and pasted by hand into the connector. `/register` is neither served nor advertised, PKCE S256 is mandatory, and the only redirect URIs accepted are the `claude.ai` and `claude.com` callbacks.
- **Single container**: the proxy is PID 1 and spawns the Python backend on loopback; if either dies, the container exits.

## Features

- **3 read-only tools** over the Google Ads API (GAQL search, resource metadata, accessible customers)
- **OAuth 2.1**: fixed client credentials, PKCE S256, fixed redirect URIs, token revocation (RFC 7009)
- **Persistent OAuth tokens**: issued tokens are written to disk, so Claude.ai does not need to re-auth after a restart
- **Stateless `/mcp`**: no session map in the proxy or the backend, nothing to grow or go stale across restarts
- **Pinned backend**: the whole Python dependency tree is pinned with hashes (`requirements.txt`), wheels only
- **Reusable security suite**: `test/security.mjs` checks the OAuth surface and the tool contract, locally or against a public URL

## Tools

Exactly three, all with `readOnlyHint`:

| Tool | What it does |
|------|--------------|
| `list_accessible_customers` | Customer ids the authenticated Google user can reach |
| `search` | GAQL query over a resource (fields, conditions, orderings, limit) |
| `get_resource_metadata` | Selectable / filterable / sortable fields of a resource |

### How the read-only guarantee works

Upstream ships four write tools (`create_asset`, `upload_video_asset`, `manage_labels`, `manage_label_associations`). Three independent fences keep them out:

1. **`tools_config.yaml`**, baked into the image and passed to the backend through `GOOGLE_ADS_MCP_TOOLS_CONFIG` (forced by the proxy, not inherited). The write namespaces (`labels`, `assets`) are off, and each read namespace has an explicit `enabled_tools` allowlist, so a new tool upstream adds to a read namespace stays off until it is reviewed. The path is explicit, so a missing file makes the backend fail instead of falling back to upstream's bundled default, which enables everything.
2. **`backend.py`** lists the tools before serving and exits unless the set is exactly the three above.
3. **`server.js`** does the same check on the tools it discovers from the backend, and only proxies what it discovered.

`test/run-local.sh` also starts the backend with upstream's default (read-write) config and checks that it refuses to start.

## Prerequisites: Google auth

The backend uses [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc) only: an `authorized_user` JSON file, pointed at by `GOOGLE_APPLICATION_CREDENTIALS` and mounted read-only. It is read lazily on the first tool call, so the server starts (and the test suite runs) without it.

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project (or use an existing one) and enable the [Google Ads API](https://console.cloud.google.com/apis/library/googleads.googleapis.com).
2. **API access level**: since 9 September 2026 the Google Ads API no longer requires a developer token or a manager account; access is granted to the Google Cloud project. The project needs at least the **Explorer** level to query production accounts. See [Developer token](https://developers.google.com/google-ads/api/docs/first-call/dev-token) and [Access levels](https://developers.google.com/google-ads/api/docs/access-levels).
3. **OAuth consent screen**: configure it and set the publishing status to **In production**. While it is in *Testing*, Google expires refresh tokens after 7 days and the server stops working a week later.
4. **OAuth client**: create an OAuth client ID of type *Desktop app* and download its JSON.
5. **Create the credentials file** with the Google Ads scope, signed in as a user who can see the Ads accounts:

   ```bash
   gcloud auth application-default login \
     --client-id-file=client_secret.json \
     --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform
   ```

   `gcloud` prints the path of the resulting `application_default_credentials.json` (type `authorized_user`). That file holds a refresh token: treat it as a secret and mount it read-only.

`GOOGLE_ADS_DEVELOPER_TOKEN` and `GOOGLE_ADS_LOGIN_CUSTOMER_ID` are still passed through to the backend if you set them (for example, to reach accounts through a manager account), but neither is required.

## Quick Start

### Docker

```bash
docker run -d \
  -e MCP_SECRET=$(openssl rand -hex 32) \
  -e SERVER_URL=https://ads-mcp.example.com \
  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/google/adc.json \
  -v /path/to/application_default_credentials.json:/secrets/google/adc.json:ro \
  -v ads-mcp-data:/data \
  -p 3000:3000 \
  ghcr.io/afonsofigs/google-ads-mcp:latest
```

Check the logs for `client_id` and `client_secret` to paste into the Claude.ai connector. Keep `MCP_SECRET` stable: rotating it changes both and revokes every issued token.

### Node.js + Python (no Docker)

Needs Node.js 22+ and [uv](https://docs.astral.sh/uv/) (or any Python 3.12 venv in `.venv`):

```bash
git clone https://github.com/afonsofigs/google-ads-mcp.git
cd google-ads-mcp
npm ci
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --require-hashes -r requirements.txt

MCP_SECRET=$(openssl rand -hex 32) \
SERVER_URL=https://ads-mcp.example.com \
TOKEN_STORE_PATH=./oauth-tokens.json \
GOOGLE_APPLICATION_CREDENTIALS=/path/to/application_default_credentials.json \
node server.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_SECRET` | Yes | Secret the OAuth client credentials are derived from (e.g. `openssl rand -hex 32`). Never passed to the backend. Rotating it revokes every issued token. |
| `SERVER_URL` | Yes | Public HTTPS URL of this server (OAuth issuer). Defaults to `http://localhost:$PORT`, which only works for local tests. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes, for tool calls | Path to the `authorized_user` ADC file. Without it the server runs, and tool calls return a clean credentials error. |
| `TOKEN_STORE_PATH` | No | Persisted OAuth tokens (default `/data/oauth-tokens.json`). Mount a writable volume there to survive restarts. |
| `PORT` | No | Proxy port (default `3000`) |
| `BACKEND_PORT` | No | Backend port on `127.0.0.1` (default `8080`) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | No | Passed through to the backend; not needed since September 2026 |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | No | Passed through to the backend; manager account id when access goes through one |

`GOOGLE_ADS_MCP_OAUTH_CLIENT_ID`, `GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET` and `GOOGLE_ADS_MCP_JWT_SIGNING_KEY` are stripped before the backend starts (by `server.js`, and again in `backend.py`): upstream would otherwise put FastMCP's own Google OAuth in front of `/mcp`, which clashes with this proxy.

## Authentication

Same pattern as [google-workspace-mcp](https://github.com/afonsofigs/google-workspace-mcp) and [telegram-bot-mcp](https://github.com/afonsofigs/telegram-bot-mcp):

- **Fixed client credentials** derived from `MCP_SECRET` via SHA-256 and printed on startup. No dynamic client registration (`/register` is neither served nor advertised): the credentials only reach a client by being pasted into its settings.
- **Rotating `MCP_SECRET` revokes everything**: on startup, codes and tokens issued to the previous `client_id` are dropped from the token store, and a bearer token of another client is refused.
- **PKCE** (S256) mandatory; `plain` is rejected.
- **Redirect URIs** limited to `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. Anything else gets a 400 with no redirect.
- **Auto-approve**: no login page; security comes from the fixed credentials.
- **Tokens**: access tokens last 24 hours; refresh tokens rotate on every use. Authorization codes are single-use.
- **Revocation**: `POST /revoke` (RFC 7009), only for tokens of the authenticated client.

### Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check (proxy and backend) |
| `GET /.well-known/oauth-authorization-server` | No | OAuth metadata (RFC 8414) |
| `GET /.well-known/oauth-protected-resource` | No | Protected resource metadata (RFC 9728) |
| `GET /authorize` | No | OAuth authorization (auto-approve) |
| `POST /token` | Client credentials | Token exchange |
| `POST /revoke` | Client credentials | Token revocation (RFC 7009) |
| `POST /mcp` | Bearer | Streamable HTTP MCP transport (stateless; `GET` / `DELETE` return 405) |

## Claude.ai Connector Setup

1. Deploy with HTTPS (e.g. behind Cloudflare Tunnel or a reverse proxy)
2. Check the logs for `client_id` and `client_secret`
3. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
4. Add a custom connector with the URL `https://ads-mcp.example.com/mcp`
5. Open **Advanced settings** and paste the `client_id` and `client_secret`. They have to be entered by hand: without dynamic client registration, a connector added without them cannot link.

## Architecture

```
Claude.ai / Scheduled Tasks
        |
        v  (HTTPS + OAuth 2.1 + Streamable HTTP)
  server.js :3000  (this project; PID 1)
        |
        v  (HTTP + MCP, 127.0.0.1:8080, stateless)
  backend.py  (googleads/google-ads-mcp, read-only tools_config.yaml)
        |
        v  (google.auth.default() <- GOOGLE_APPLICATION_CREDENTIALS)
  Google Ads API
```

- `node server.js` spawns `.venv/bin/python -I backend.py`. If the backend exits, the proxy exits with 1; SIGTERM on the proxy stops both.
- Upstream's own entrypoint only serves HTTP behind FastMCP's Google OAuth. `backend.py` runs the same `mcp` object over plain HTTP, bound to loopback only.
- The image runs as uid/gid 1000 with `HOME=/tmp`; the app tree is root-owned and read-only for it, and it writes only to `/data` and `/tmp`.

## Kubernetes Deployment

A minimal example. Create the Secret out of band, for instance:

```bash
kubectl create secret generic ads-mcp-secrets \
  --from-literal=MCP_SECRET="$(openssl rand -hex 32)" \
  --from-file=adc.json=/path/to/application_default_credentials.json
```

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ads-mcp-data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Mi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ads-mcp
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: ads-mcp
  template:
    metadata:
      labels:
        app: ads-mcp
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: ads-mcp
          image: ghcr.io/afonsofigs/google-ads-mcp:latest
          ports:
            - containerPort: 3000
          env:
            - name: MCP_SECRET
              valueFrom:
                secretKeyRef:
                  name: ads-mcp-secrets
                  key: MCP_SECRET
            - name: SERVER_URL
              value: "https://ads-mcp.example.com"
            - name: GOOGLE_APPLICATION_CREDENTIALS
              value: /secrets/google/adc.json
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
          volumeMounts:
            - name: data
              mountPath: /data
            - name: tmp
              mountPath: /tmp
            - name: google
              mountPath: /secrets/google
              readOnly: true
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ads-mcp-data
        - name: tmp
          emptyDir: {}
        - name: google
          secret:
            secretName: ads-mcp-secrets
            items:
              - key: adc.json
                path: adc.json
```

Expose it with a ClusterIP Service behind a tunnel or an HTTPS ingress. The PVC keeps the OAuth tokens across restarts; without it Claude.ai has to re-auth every time the pod is recreated.

## Security Tests

`test/security.mjs` (Node 22+, no dependencies) checks the OAuth surface (metadata, `/register` 404, `/authorize` rejections, PKCE, client authentication, code replay), `/mcp` authentication, the exact tool list, a refused write-tool call and a tool call. It prints only statuses, names and error text, never secrets or tokens.

### Locally

`test/run-local.sh` runs the proxy and the backend as native processes, with no Docker and no Google credentials. It generates a throwaway `MCP_SECRET`, runs the suite five times, and also checks that the backend refuses upstream's read-write config, that `MCP_SECRET` and the `GOOGLE_ADS_MCP_OAUTH_*` variables never reach the backend's environment, that no secret or full token shows up in the logs, and that no process is left behind.

```bash
npm ci
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --require-hashes -r requirements.txt

npm test                                   # = bash test/run-local.sh
LOG_DIR=/some/private/dir npm test         # keep the logs (chmod 600); default: a fresh temp dir
PORT=3100 BACKEND_PORT=8180 npm test       # if 3000 / 8080 are taken
```

The proxy log contains the `client_secret` startup line by design: grep it, don't share it.

### Against a deployment

```bash
BASE_URL=https://ads-mcp.example.com MCP_SECRET=... EXPECT_ADC=present \
  node test/security.mjs
```

Instead of `MCP_SECRET` you can pass `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`. `EXPECT_ADC=present` requires `list_accessible_customers` to return customers; `missing` requires a clean credentials error; unset only checks that the call does not crash. Each run issues one access and refresh token pair in the target's token store.

## Security Notes

- The server exposes your Google Ads data to whatever client holds the connector credentials. Anyone with `MCP_SECRET` (or the derived `client_id` / `client_secret`) can link a connector, so keep it in a secret store and rotate it if it leaks.
- `/authorize` auto-approves; it is protected by the fixed client, PKCE and the redirect URI allowlist, not by a login page. Put the server behind your own access controls if you need more.
- The ADC file contains a Google refresh token with the `adwords` scope. Mount it read-only and do not bake it into an image. Read-only here means the MCP tools cannot write; the token itself could, so guard it like any Google credential.
- The token store (`oauth-tokens.json`) holds live bearer and refresh tokens; keep its volume private.
- The proxy logs only token prefixes (8 characters), never full tokens, codes or `MCP_SECRET`.

## Updating the backend

`requirements.in` holds the one direct pin; `requirements.txt` is generated:

```bash
uv pip compile requirements.in --generate-hashes --python-version 3.12 \
  --python-platform x86_64-manylinux_2_28 -o requirements.txt
```

Then run `npm test`: a new upstream tool in a read namespace stays off (explicit `enabled_tools`), and any change to the tool set stops the backend from starting until `tools_config.yaml` and the allowlists in `backend.py`, `server.js` and `test/security.mjs` are reviewed. Renovate keeps both the npm and the pinned Python dependencies up to date (`renovate.json`).

## Credits

- [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp) by Google, the MCP backend, licensed under [Apache-2.0](https://github.com/googleads/google-ads-mcp/blob/main/LICENSE). It is installed from PyPI at build time; no upstream code is vendored in this repository.
- Proxy based on [google-workspace-mcp](https://github.com/afonsofigs/google-workspace-mcp) (same OAuth 2.1 proxy pattern).
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [express](https://expressjs.com/) and [zod](https://zod.dev/).

## License

MIT for the code in this repository. The `google-ads-mcp` backend installed into the Docker image is Apache-2.0.
