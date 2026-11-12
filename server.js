import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import express from "express";
import { z } from "zod";
import { spawn } from "node:child_process";
import { join } from "node:path";

// --- Configuration ---

const MCP_SECRET = process.env.MCP_SECRET;
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || "8080", 10);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const APP_DIR = import.meta.dirname;

// The only tools this server may expose. tools_config.yaml disables the write
// namespaces (labels, assets) in the backend, and backend.py refuses to start
// on any other tool set; this is the same fence on the proxy side.
const READ_ONLY_TOOLS = ["list_accessible_customers", "search", "get_resource_metadata"];

if (!MCP_SECRET) {
  console.error("Error: MCP_SECRET environment variable is required");
  process.exit(1);
}

// --- Start Google Ads MCP backend ---

// The backend gets only what it needs. MCP_SECRET derives the OAuth client
// credentials and never leaves this process. GOOGLE_ADS_MCP_OAUTH_CLIENT_ID /
// _SECRET would switch upstream to FastMCP's own Google OAuth on /mcp, which
// clashes with this proxy, so they are stripped here (and again in backend.py).
const backendEnv = { ...process.env };
for (const key of [
  "MCP_SECRET",
  "GOOGLE_ADS_MCP_OAUTH_CLIENT_ID",
  "GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET",
  "GOOGLE_ADS_MCP_JWT_SIGNING_KEY",
]) {
  delete backendEnv[key];
}
backendEnv.BACKEND_PORT = String(BACKEND_PORT);
// Forced, not inherited: the read-only config baked into the image.
backendEnv.GOOGLE_ADS_MCP_TOOLS_CONFIG = join(APP_DIR, "tools_config.yaml");

const backend = spawn(
  join(APP_DIR, ".venv", "bin", "python"),
  // -I: isolated mode, ignores PYTHON* env vars and the user site-packages.
  ["-I", join(APP_DIR, "backend.py")],
  {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: APP_DIR,
    env: backendEnv,
  }
);

let shuttingDown = false;
backend.stdout.on("data", (d) => process.stdout.write(`[backend] ${d}`));
backend.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));
backend.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[backend] google-ads-mcp exited with code ${code} signal ${signal}`);
  process.exit(1);
});
backend.on("error", (err) => {
  console.error(`[backend] failed to start: ${err.message}`);
  process.exit(1);
});

// One process tree per container: if the proxy goes, the backend goes with it.
// Node as PID 1 ignores SIGTERM without a handler, so without these the pod
// waits out the whole grace period and gets SIGKILLed.
process.on("exit", () => {
  shuttingDown = true;
  backend.kill("SIGTERM");
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down`);
    process.exit(0);
  });
}

// Wait for backend to be ready
const BACKEND_START_TIMEOUT_MS = 120_000;
await new Promise((resolve) => {
  const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
  const check = async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/health`);
      if (r.ok) return resolve();
    } catch {}
    if (Date.now() > deadline) {
      console.error(`[backend] not healthy after ${BACKEND_START_TIMEOUT_MS / 1000}s`);
      process.exit(1);
    }
    setTimeout(check, 500);
  };
  check();
});
console.log(`Backend ready at ${BACKEND_URL}`);

// --- Discover tools from backend ---

async function backendMcpCall(method, params = {}) {
  const initRes = await fetch(`${BACKEND_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "oauth-proxy", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  await initRes.text();
  const sessionId = initRes.headers.get("mcp-session-id");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  };

  try {
    await fetch(`${BACKEND_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const res = await fetch(`${BACKEND_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 2 }),
    });

    const text = await res.text();
    const match = text.match(/data: (.+)/);
    return match ? JSON.parse(match[1]) : JSON.parse(text);
  } finally {
    // Every call opens a backend session; left open, the backend keeps them
    // forever and its memory grows until the pod is OOM-killed.
    if (sessionId) {
      await fetch(`${BACKEND_URL}/mcp`, { method: "DELETE", headers }).catch(() => {});
    }
  }
}

const toolsResponse = await backendMcpCall("tools/list");
const backendTools = toolsResponse.result?.tools || [];
console.log(`Discovered ${backendTools.length} tools: ${backendTools.map((t) => t.name).join(", ")}`);

const discovered = backendTools.map((t) => t.name).sort().join(",");
if (discovered !== [...READ_ONLY_TOOLS].sort().join(",")) {
  console.error(`Refusing to start: backend tools [${discovered}] are not exactly the read-only allowlist [${READ_ONLY_TOOLS.join(", ")}]`);
  process.exit(1);
}

// --- OAuth 2.1 Provider (file-persisted, survives pod restarts) ---

const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || "/data/oauth-tokens.json";

const FIXED_CLIENT_ID = createHash("sha256").update(`${MCP_SECRET}:client_id`).digest("hex").slice(0, 36);
const FIXED_CLIENT_SECRET = createHash("sha256").update(`${MCP_SECRET}:client_secret`).digest("hex");

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { tokens: {}, codes: {} };
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      }
    } catch (err) {
      console.warn(`[tokenstore] Failed to load ${this.filePath}: ${err.message}, starting fresh`);
      this.data = { tokens: {}, codes: {} };
    }
    this._dropForeign();
  }

  /**
   * The client id is derived from MCP_SECRET, so rotating the secret must
   * revoke everything issued before it. Every record names its client (tokens
   * by `clientId`, codes by `client.client_id`); one that names another
   * client, or none, is dropped.
   */
  _dropForeign() {
    const { tokens = {}, codes = {} } = this.data;
    const keep = (entries, idOf) => Object.fromEntries(entries.filter(([, v]) => idOf(v) === FIXED_CLIENT_ID));
    this.data = {
      tokens: keep(Object.entries(tokens), (v) => v?.clientId),
      codes: keep(Object.entries(codes), (v) => v?.client?.client_id),
    };
    const dropped = Object.keys(tokens).length + Object.keys(codes).length -
      Object.keys(this.data.tokens).length - Object.keys(this.data.codes).length;
    if (dropped) {
      console.log(`[tokenstore] Dropped ${dropped} record(s) issued to another client (MCP_SECRET rotated)`);
      this._save();
    }
  }

  _save() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data));
    } catch (err) {
      console.error(`[tokenstore] Failed to save ${this.filePath}: ${err.message}`);
    }
  }

  getToken(key) { return this.data.tokens[key]; }
  setToken(key, value) { this.data.tokens[key] = value; this._save(); }
  deleteToken(key) { delete this.data.tokens[key]; this._save(); }

  getCode(key) { return this.data.codes[key]; }
  setCode(key, value) { this.data.codes[key] = value; this._save(); }
  deleteCode(key) { delete this.data.codes[key]; this._save(); }
}

class ClientsStore {
  constructor() {
    this.client = {
      client_id: FIXED_CLIENT_ID,
      client_secret: FIXED_CLIENT_SECRET,
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ],
      client_name: "Claude",
      token_endpoint_auth_method: "client_secret_post",
    };
  }
  // No registerClient: without it the SDK neither mounts nor advertises
  // /register, which would hand the fixed client_secret to anyone who asked.
  // The credentials are entered by hand in the connector's settings.
  async getClient(clientId) {
    return clientId === FIXED_CLIENT_ID ? this.client : undefined;
  }
}

class OAuthProvider {
  constructor(store) {
    this.clientsStore = new ClientsStore();
    this.store = store;
  }

  async authorize(client, params, res) {
    console.log(`[oauth] authorize: client=${client.client_id} redirect=${params.redirectUri}`);
    const code = randomUUID();
    this.store.setCode(code, { client, params, createdAt: Date.now() });
    const searchParams = new URLSearchParams({ code });
    if (params.state) searchParams.set("state", params.state);
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(_client, code) {
    const data = this.store.getCode(code);
    // OAuth errors, not plain Error: the SDK turns a plain Error into a 500
    // server_error, so a replayed or unknown code looked like a server fault
    // instead of the 400 invalid_grant RFC 6749 calls for.
    if (!data) throw new InvalidGrantError("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier) {
    console.log(`[oauth] exchangeCode: client=${client.client_id} code=${code.slice(0, 8)}...`);
    const data = this.store.getCode(code);
    if (!data) throw new InvalidGrantError("Invalid authorization code");
    if (data.client.client_id !== client.client_id) throw new InvalidGrantError("Client mismatch");
    this.store.deleteCode(code);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 86400;

    this.store.setToken(accessToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      expiresAt: Date.now() + expiresIn * 1000,
      resource: data.params.resource,
    });
    this.store.setToken(refreshToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      type: "refresh",
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (data.params.scopes || []).join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, _resource) {
    const data = this.store.getToken(refreshToken);
    if (!data || data.type !== "refresh") throw new InvalidGrantError("Invalid refresh token");
    if (data.clientId !== client.client_id) throw new InvalidGrantError("Client mismatch");
    this.store.deleteToken(refreshToken);

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const expiresIn = 86400;

    this.store.setToken(newAccessToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    this.store.setToken(newRefreshToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      type: "refresh",
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: (scopes || data.scopes).join(" "),
    };
  }

  async verifyAccessToken(token) {
    console.log(`[oauth] verifyToken: ${token.slice(0, 8)}...`);
    const data = this.store.getToken(token);
    if (!data || data.type === "refresh" || data.clientId !== FIXED_CLIENT_ID) throw new InvalidTokenError("Invalid token");
    if (data.expiresAt && data.expiresAt < Date.now()) {
      this.store.deleteToken(token);
      throw new InvalidTokenError("Token expired");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt ? Math.floor(data.expiresAt / 1000) : undefined,
      resource: data.resource,
    };
  }

  // RFC 7009: an unknown token, or one of another client, is still a 200.
  async revokeToken(client, request) {
    const data = this.store.getToken(request.token);
    if (data && data.clientId === client.client_id) this.store.deleteToken(request.token);
  }
}

// --- MCP Server (proxy tools to backend) ---

// Pydantic emits optional and union parameters as anyOf (e.g. `limit: int |
// None` is anyOf [integer, null], `customer_id: str | int` is anyOf [string,
// integer]). Without this they fell through to z.string() and the proxy
// rejected a numeric limit before it reached the backend.
function jsonSchemaToZod(prop, isRequired) {
  let schema;
  if (Array.isArray(prop.anyOf)) {
    const members = prop.anyOf.filter((v) => v.type !== "null").map((v) => jsonSchemaToZod(v, true));
    const nullable = members.length !== prop.anyOf.length;
    if (members.length === 0) schema = z.null();
    else schema = members.length === 1 ? members[0] : z.union(members);
    if (nullable && members.length) schema = schema.nullable();
  } else {
    switch (prop.type) {
      case "number":
        schema = z.number();
        break;
      case "integer":
        schema = z.number().int();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "array":
        schema = z.array(prop.items ? jsonSchemaToZod(prop.items, true) : z.any());
        break;
      case "object":
        schema = z.record(z.string(), z.any());
        break;
      default:
        schema = z.string();
    }
  }
  if (prop.description) schema = schema.describe(prop.description);
  if (!isRequired) schema = schema.optional();
  return schema;
}

function createMcpServer() {
  const server = new McpServer({ name: "google-ads-mcp", version: "1.0.0" });

  for (const tool of backendTools) {
    const properties = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    const shape = {};

    for (const [key, prop] of Object.entries(properties)) {
      shape[key] = jsonSchemaToZod(prop, required.has(key));
    }

    server.registerTool(tool.name, {
      description: tool.description || tool.name,
      inputSchema: shape,
      annotations: tool.annotations,
    }, async (args) => {
      try {
        const result = await backendMcpCall("tools/call", { name: tool.name, arguments: args });
        if (result.result) return result.result;
        if (result.error) {
          return { content: [{ type: "text", text: `Backend error: ${result.error.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Proxy error: ${err.message}` }], isError: true };
      }
    });
  }

  return server;
}

// --- Express App ---

const tokenStore = new TokenStore(TOKEN_STORE_PATH);
const provider = new OAuthProvider(tokenStore);
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.get("/health", async (_, res) => {
  try {
    const r = await fetch(`${BACKEND_URL}/health`);
    const body = await r.json();
    const ok = body.status === "healthy";
    res.status(ok ? 200 : 503).json({ ok, version: "1.0.0", backend: true });
  } catch {
    res.status(503).json({ ok: false, version: "1.0.0", backend: false });
  }
});

const issuerUrl = new URL(SERVER_URL);
app.use(mcpAuthRouter({
  provider,
  issuerUrl,
  scopesSupported: ["mcp:tools"],
}));

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log(`[auth] ${req.method} ${req.path} auth=${authHeader ? authHeader.slice(0, 20) + "..." : "none"}`);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "Missing token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const authInfo = await provider.verifyAccessToken(token);
    req.auth = authInfo;
    next();
  } catch (err) {
    res.status(401).set("WWW-Authenticate", `Bearer error="invalid_token"`).json({ error: err.message });
  }
};

// Stateless: a fresh server and transport per request, no session map. The
// proxy keeps no per-session state, and holding sessions meant (a) the map grew
// without bound until the pod was OOM-killed, and (b) after any restart clients
// still sending the old mcp-session-id got 400 "Server not initialized", which
// Claude.ai does not recover from.
app.post("/mcp", authMiddleware, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[mcp] POST error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const methodNotAllowed = (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", authMiddleware, methodNotAllowed);
app.delete("/mcp", authMiddleware, methodNotAllowed);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`google-ads-mcp v1.0.0 listening on :${PORT}`);
  console.log(`Backend: ${BACKEND_URL}/mcp (googleads/google-ads-mcp, read-only)`);
  console.log(`OAuth issuer: ${SERVER_URL}`);
  console.log(`OAuth client_id: ${FIXED_CLIENT_ID}`);
  console.log(`OAuth client_secret: ${FIXED_CLIENT_SECRET}`);
  console.log(`MCP endpoint: ${SERVER_URL}/mcp (Streamable HTTP)`);
  console.log(`Tools: ${backendTools.map((t) => t.name).join(", ")}`);
});
