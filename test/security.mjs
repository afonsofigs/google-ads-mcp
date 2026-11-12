#!/usr/bin/env node
// Security and contract checks for the google-ads-mcp OAuth proxy.
//
// Runs against a local process or the public URL. Node 22+, no dependencies.
//
//   BASE_URL           default http://localhost:3000
//   MCP_SECRET         derives the client credentials the same way server.js does
//   MCP_CLIENT_ID      } or pass the credentials directly (they win over
//   MCP_CLIENT_SECRET  } MCP_SECRET when both are set)
//   EXPECT_ADC=missing  list_accessible_customers must fail cleanly (no ADC)
//   EXPECT_ADC=present  list_accessible_customers must return customer ids
//   EXPECT_ADC unset    the call must just not crash the server
//
// Never prints secrets, tokens or codes: only statuses, names and error text.
//
//   MCP_SECRET=... node test/security.mjs
//   BASE_URL=https://ads-mcp.example.com MCP_SECRET=... node test/security.mjs

import { createHash, randomBytes } from "node:crypto";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.MCP_SECRET;
const CLIENT_ID = process.env.MCP_CLIENT_ID
  || (SECRET && createHash("sha256").update(`${SECRET}:client_id`).digest("hex").slice(0, 36));
const CLIENT_SECRET = process.env.MCP_CLIENT_SECRET
  || (SECRET && createHash("sha256").update(`${SECRET}:client_secret`).digest("hex"));
const EXPECT_ADC = process.env.EXPECT_ADC || "";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const READ_ONLY_TOOLS = ["get_resource_metadata", "list_accessible_customers", "search"];
const WRITE_TOOLS = ["create_asset", "upload_video_asset", "manage_labels", "manage_label_associations"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set MCP_SECRET, or MCP_CLIENT_ID and MCP_CLIENT_SECRET.");
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const b64url = (buf) => buf.toString("base64url");
const newVerifier = () => b64url(randomBytes(32));
const s256 = (v) => b64url(createHash("sha256").update(v).digest());

async function authorize(overrides = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "st-" + b64url(randomBytes(6)),
    scope: "mcp:tools",
    ...overrides,
  });
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) params.delete(k);
  const res = await fetch(`${BASE_URL}/authorize?${params}`, { redirect: "manual" });
  const location = res.headers.get("location") || "";
  let code = null;
  let error = null;
  if (location) {
    const u = new URL(location);
    code = u.searchParams.get("code");
    error = u.searchParams.get("error");
  }
  return { status: res.status, location, code, error };
}

// A rejected authorize either answers 4xx directly (bad client/redirect_uri,
// where redirecting would be an open redirect) or redirects back with error=
// and no code. Either way no code may come out.
const rejected = (r) => !r.code && (r.status >= 400 || (r.status === 302 && !!r.error));

async function token(form) {
  const res = await fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function mcp(accessToken, method, params, id = 1) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let json = null;
  const data = text.match(/^data: (.+)$/m);
  try { json = JSON.parse(data ? data[1] : text); } catch {}
  return { status: res.status, json };
}

// --- metadata, /register ---

{
  const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
  const md = await res.json().catch(() => ({}));
  check("AS metadata is served", res.status === 200, `status ${res.status}`);
  check("metadata has no registration_endpoint", !("registration_endpoint" in md));
  check(
    "code_challenge_methods_supported is exactly [S256]",
    JSON.stringify(md.code_challenge_methods_supported) === JSON.stringify(["S256"]),
    JSON.stringify(md.code_challenge_methods_supported),
  );
}

{
  const res = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "probe" }),
  });
  check("POST /register -> 404", res.status === 404, `status ${res.status}`);
}

// --- /authorize rejections ---

{
  const r = await authorize({ code_challenge: undefined, code_challenge_method: undefined });
  check("authorize without code_challenge is rejected", rejected(r), `status ${r.status} error=${r.error}`);
}
{
  const v = newVerifier();
  const r = await authorize({ code_challenge: v, code_challenge_method: "plain" });
  check("authorize with code_challenge_method=plain is rejected", rejected(r), `status ${r.status} error=${r.error}`);
}
{
  const r = await authorize({
    code_challenge: s256(newVerifier()),
    code_challenge_method: "S256",
    redirect_uri: "https://evil.example/api/mcp/auth_callback",
  });
  check(
    "authorize with redirect_uri outside the allowlist is rejected (no redirect)",
    r.status === 400 && !r.location,
    `status ${r.status}`,
  );
}
{
  const r = await authorize({
    client_id: "not-the-client",
    code_challenge: s256(newVerifier()),
    code_challenge_method: "S256",
  });
  check("authorize with an unknown client_id is rejected (no redirect)", r.status === 400 && !r.location, `status ${r.status}`);
}

// --- full PKCE flow ---

const verifier = newVerifier();
const auth = await authorize({ code_challenge: s256(verifier), code_challenge_method: "S256" });
check("authorize with PKCE S256 redirects with a code", auth.status === 302 && !!auth.code, `status ${auth.status}`);

const baseForm = {
  grant_type: "authorization_code",
  code: auth.code || "",
  redirect_uri: REDIRECT_URI,
  client_id: CLIENT_ID,
};

{
  const r = await token({ ...baseForm, client_secret: CLIENT_SECRET, code_verifier: newVerifier() });
  check("token with a wrong code_verifier is rejected", r.status === 400 && !r.body.access_token, `status ${r.status} ${r.body.error}`);
}
{
  const r = await token({ ...baseForm, client_secret: "wrong-" + CLIENT_SECRET.slice(6), code_verifier: verifier });
  check("token with a wrong client_secret is rejected", r.status >= 400 && r.status < 500 && !r.body.access_token, `status ${r.status} ${r.body.error}`);
}
{
  const r = await token({ ...baseForm, code_verifier: verifier });
  check("token without client_secret is rejected", r.status >= 400 && r.status < 500 && !r.body.access_token, `status ${r.status} ${r.body.error}`);
}

const tok = await token({ ...baseForm, client_secret: CLIENT_SECRET, code_verifier: verifier });
const accessToken = tok.body.access_token;
const refreshToken = tok.body.refresh_token;
check("token with the right verifier and secret -> access_token", tok.status === 200 && !!accessToken, `status ${tok.status}`);

{
  const r = await token({ ...baseForm, client_secret: CLIENT_SECRET, code_verifier: verifier });
  check("authorization code cannot be reused", r.status === 400 && !r.body.access_token, `status ${r.status} ${r.body.error}`);
}

// --- /mcp auth ---

{
  const r = await mcp(undefined, "tools/list", {});
  check("/mcp without a token -> 401", r.status === 401, `status ${r.status}`);
}
{
  const r = await mcp("00000000-0000-4000-8000-000000000000", "tools/list", {});
  check("/mcp with an invalid token -> 401", r.status === 401, `status ${r.status}`);
}
{
  const r = await mcp(refreshToken || "none", "tools/list", {});
  check("/mcp with the refresh token as bearer -> 401", r.status === 401, `status ${r.status}`);
}

// --- /mcp with a token ---

{
  const r = await mcp(accessToken, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "security-test", version: "1.0.0" },
  });
  check(
    "initialize succeeds",
    r.status === 200 && r.json?.result?.serverInfo?.name === "google-ads-mcp",
    `status ${r.status} server=${r.json?.result?.serverInfo?.name}`,
  );
}

{
  const r = await mcp(accessToken, "tools/list", {}, 2);
  const names = (r.json?.result?.tools || []).map((t) => t.name).sort();
  check("tools/list is exactly the 3 read tools", JSON.stringify(names) === JSON.stringify(READ_ONLY_TOOLS), names.join(", "));
  check("tools/list has no write tool", !names.some((n) => WRITE_TOOLS.some((w) => n.includes(w))));
  const allReadOnly = (r.json?.result?.tools || []).every((t) => t.annotations?.readOnlyHint === true);
  check("every tool carries readOnlyHint", allReadOnly);
}

{
  const r = await mcp(accessToken, "tools/call", { name: "manage_labels", arguments: {} }, 3);
  const text = r.json?.result?.content?.[0]?.text || r.json?.error?.message || "";
  check(
    "tools/call of a write tool is refused",
    r.json?.error || r.json?.result?.isError === true,
    text.slice(0, 120),
  );
}

{
  const r = await mcp(accessToken, "tools/call", { name: "list_accessible_customers", arguments: {} }, 4);
  const res = r.json?.result;
  const text = res?.content?.map((c) => c.text).join(" ") || r.json?.error?.message || "";
  if (EXPECT_ADC === "missing") {
    check(
      "list_accessible_customers without ADC -> clean tool error",
      r.status === 200 && res?.isError === true && /credentials/i.test(text),
      text.slice(0, 160),
    );
  } else if (EXPECT_ADC === "present") {
    check("list_accessible_customers returns customers", r.status === 200 && res && !res.isError, text.slice(0, 160));
  } else {
    check("list_accessible_customers answers (no crash)", r.status === 200 && !!res, `isError=${res?.isError} ${text.slice(0, 160)}`);
  }
}

{
  // limit is anyOf [integer, null] in the backend schema: a number must get
  // through the proxy's zod validation and reach the backend.
  const r = await mcp(accessToken, "tools/call", {
    name: "search",
    arguments: { customer_id: "1234567890", fields: ["campaign.id"], resource: "campaign", limit: 1 },
  }, 5);
  const text = r.json?.result?.content?.map((c) => c.text).join(" ") || r.json?.error?.message || "";
  check(
    "search with a numeric limit passes proxy validation",
    r.status === 200 && !/Input validation error|invalid_type|Expected string/i.test(text),
    text.slice(0, 160),
  );
}

{
  const res = await fetch(`${BASE_URL}/health`);
  const body = await res.json().catch(() => ({}));
  check("/health ok after the calls", res.status === 200 && body.ok === true, `status ${res.status}`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
