/**
 * End-to-end verification of the multi-user OAuth flow + RLS isolation.
 *
 * Signs in as a (non-owner) test user with email/password, walks the full
 * OAuth code + PKCE exchange the way an MCP client would, then exercises
 * the MCP endpoint: listing tools/prompts, reading the (empty) portfolio,
 * checking that a foreign task can't be modified, and round-tripping a
 * create/delete. Finishes with a refresh_token grant.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-oauth.mjs \
 *     <base_url> <email> <password> [foreign_task_id]
 */
import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";

const [base, email, password, foreignEventId] = process.argv.slice(2);
if (!base || !email || !password) {
  console.error("usage: verify-oauth.mjs <base_url> <email> <password> [foreign_event_id]");
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. Sign in as the test user (what the authorize page does via Google)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
if (signInErr) {
  console.error("Could not sign in test user:", signInErr.message);
  process.exit(1);
}
const session = signIn.session;
console.log(`Signed in as ${email} (${session.user.id})`);

// 2. PKCE pair + approve → auth code
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "http://localhost:8123/callback";

const approveRes = await fetch(`${base}/oauth/authorize/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: "verify-script",
    redirect_uri: redirectUri,
    state: "xyz",
    code_challenge: challenge,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  }),
});
check("approve endpoint accepts a valid session", approveRes.ok, `status ${approveRes.status}`);
const { redirect } = await approveRes.json();
const code = new URL(redirect).searchParams.get("code");
check("auth code issued", !!code);

// 2b. A garbage access token must be rejected
const badApprove = await fetch(`${base}/oauth/authorize/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: "verify-script",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    access_token: "garbage",
    refresh_token: "garbage",
  }),
});
check("approve rejects an invalid session token", badApprove.status === 401, `status ${badApprove.status}`);

// 3. Token exchange (authorization_code + PKCE)
const tokenRes = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }),
});
const tokens = await tokenRes.json();
check("token exchange succeeds", tokenRes.ok && !!tokens.access_token);
check("access token is a JWT (Supabase session)", (tokens.access_token || "").split(".").length === 3);
check("refresh token returned", !!tokens.refresh_token);
check("expires_in ≈ 1h", tokens.expires_in > 600 && tokens.expires_in <= 86400, `expires_in=${tokens.expires_in}`);

// 3b. Wrong PKCE verifier must fail (fresh code, since GoTrue consumed the last one)
const approve2 = await (await fetch(`${base}/oauth/authorize/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: "verify-script",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  }),
})).json();
const code2 = new URL(approve2.redirect).searchParams.get("code");
const badPkce = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: code2,
    code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
    redirect_uri: redirectUri,
  }),
});
check("token exchange rejects a bad PKCE verifier", badPkce.status === 400, `status ${badPkce.status}`);

// 4. MCP endpoint with the issued token
const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
});
const mcp = new Client({ name: "verify-script", version: "1.0.0" });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
check("tools listed", tools.length === 10, `${tools.length} tools`);
const getContacts = tools.find((t) => t.name === "get_contacts");
check("read tools annotated readOnlyHint", getContacts?.annotations?.readOnlyHint === true);
const delTool = tools.find((t) => t.name === "delete_event");
check("delete_event annotated destructiveHint", delTool?.annotations?.destructiveHint === true);

const { prompts } = await mcp.listPrompts();
check("2 prompts listed", prompts.length === 2, prompts.map((p) => p.name).join(", "));

// 5. Isolation: the test user sees only their own contacts.
//    (mcpemailtest has no Tend User row until verifyToken auto-creates it,
//    so this also exercises first-login provisioning.)
const contacts = JSON.parse(
  (await mcp.callTool({ name: "get_contacts", arguments: {} })).content[0].text
);
const contactCount = Array.isArray(contacts) ? contacts.length : (contacts.contacts?.length ?? 0);
check("test user contacts are isolated", contactCount === 0, `count=${contactCount}`);

if (foreignEventId) {
  const res = await mcp.callTool({ name: "delete_event", arguments: { event_id: foreignEventId } });
  const resText = res.content?.[0]?.text || "";
  check("cannot delete another user's event",
    res.isError === true || resText.includes("not found"), resText.slice(0, 80));
}

// 6. Write path works for the user's own data
const added = JSON.parse(
  (await mcp.callTool({ name: "add_contact", arguments: { name: "Verify Smoke Test" } })).content[0].text
);
const newContactId = added.contact?.id || added.id;
check("test user can add own contact", !!newContactId, JSON.stringify(added).slice(0, 80));

// Cleanup: hard-delete the smoke contact via the service role (no delete_contact tool)
if (newContactId) {
  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: delErr } = await svc.from("Contact").delete().eq("id", newContactId);
  check("cleanup: smoke contact deleted", !delErr, delErr?.message);
}

await mcp.close();

// 7. refresh_token grant
const refreshRes = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
});
const refreshed = await refreshRes.json();
check("refresh_token grant issues a new pair", refreshRes.ok && !!refreshed.access_token && !!refreshed.refresh_token);

const transport2 = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } },
});
const mcp2 = new Client({ name: "verify-script-2", version: "1.0.0" });
await mcp2.connect(transport2);
check("refreshed token works against MCP", (await mcp2.listTools()).tools.length === 11);
await mcp2.close();

// 8. No token → 401 with resource metadata pointer
const unauth = await fetch(`${base}/api/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("unauthenticated request rejected", unauth.status === 401, `status ${unauth.status}`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
