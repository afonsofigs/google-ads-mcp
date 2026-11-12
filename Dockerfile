# Node.js OAuth proxy (server.js) + Python backend (googleads/google-ads-mcp),
# one container, one process tree: node is PID 1 and spawns backend.py.

# --- proxy dependencies ---
FROM node:22-slim AS node
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# --- runtime ---
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# The node binary only needs glibc, libstdc++ and libgcc_s, which the Debian
# slim base already has (apt links them), so no nodesource repo or apt layer.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Backend: google-ads-mcp and its whole dependency tree, pinned with hashes
# (requirements.txt is `uv pip compile --generate-hashes` of requirements.in).
# Wheels only, nothing is built here. pip precompiles the .pyc at install time,
# so the read-only app tree needs no writes at runtime.
COPY requirements.txt ./
RUN python -m venv /app/.venv \
    && /app/.venv/bin/pip install --require-hashes --only-binary :all: --no-deps -r requirements.txt \
    && /app/.venv/bin/python -I -c "import ads_mcp.server"

COPY --from=node /app/node_modules ./node_modules
COPY package.json server.js backend.py tools_config.yaml ./

# Non-root, numeric 1000 to match the pod's runAsUser/runAsGroup/fsGroup.
# The app tree stays root-owned and read-only for it; the only writable paths
# are /data (token store, a PVC in the pod) and /tmp (HOME in the pod).
RUN groupadd --gid 1000 mcp \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin mcp \
    && mkdir -p /data \
    && chown 1000:1000 /data

USER 1000:1000

ENV HOME=/tmp \
    PORT=3000 \
    BACKEND_PORT=8080 \
    TOKEN_STORE_PATH=/data/oauth-tokens.json

EXPOSE 3000

CMD ["node", "server.js"]
