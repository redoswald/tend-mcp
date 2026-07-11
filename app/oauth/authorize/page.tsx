"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { browserClient } from "@/lib/supabase-browser";

interface OAuthParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

const STORAGE_KEY = "mcp_oauth_params";

/**
 * OAuth authorization page. The MCP client sends the user here; they sign
 * in with their Intend (Supabase) account, then approve access. OAuth
 * params are stashed in sessionStorage across the Google redirect so the
 * GoTrue redirect allowlist only needs the bare /oauth/authorize URL.
 */
export default function AuthorizePage() {
  const [params, setParams] = useState<OAuthParams | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [phase, setPhase] = useState<"loading" | "signin" | "consent" | "working">("loading");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // OAuth params only exist client-side (URL query / sessionStorage), so
  // this must initialize state from an effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    let p: OAuthParams | null = null;

    if (qs.get("client_id")) {
      const method = qs.get("code_challenge_method");
      if (method && method !== "S256") {
        setError("Only the S256 code challenge method is supported.");
        return;
      }
      p = {
        clientId: qs.get("client_id") || "",
        redirectUri: qs.get("redirect_uri") || "",
        state: qs.get("state") || "",
        codeChallenge: qs.get("code_challenge") || "",
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } else {
      // Returning from the Google sign-in redirect
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) p = JSON.parse(stored);
    }

    if (!p || !p.clientId || !p.redirectUri || !p.codeChallenge) {
      setError("Missing required authorization parameters.");
      return;
    }
    setParams(p);

    const supabase = browserClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setPhase(data.session ? "consent" : "signin");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setPhase(s ? "consent" : "signin");
    });
    return () => sub.subscription.unsubscribe();
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleSignIn() {
    const supabase = browserClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/oauth/authorize` },
    });
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    setSignInError(null);
    const { error: err } = await browserClient().auth.signInWithPassword({ email, password });
    if (err) {
      setSignInError(
        err.message === "Invalid login credentials"
          ? "Invalid email or password."
          : err.message
      );
    }
    // On success onAuthStateChange flips the page to the consent phase
    setSigningIn(false);
  }

  async function handleApprove() {
    if (!params || !session) return;
    setPhase("working");

    const res = await fetch("/oauth/authorize/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        state: params.state,
        code_challenge: params.codeChallenge,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }),
    });

    if (!res.ok) {
      setError("Authorization failed. Please try again.");
      setPhase("consent");
      return;
    }

    const { redirect } = await res.json();
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.href = redirect;
  }

  function handleDeny() {
    if (!params) return;
    sessionStorage.removeItem(STORAGE_KEY);
    const denyUrl = new URL(params.redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    if (params.state) denyUrl.searchParams.set("state", params.state);
    window.location.href = denyUrl.toString();
  }

  async function handleSwitchAccount() {
    await browserClient().auth.signOut();
  }

  return (
    <div className="wrap">
      <style>{styles}</style>
      <div className="card">
        <h1>Tend</h1>
        {error ? (
          <p className="error">{error}</p>
        ) : phase === "loading" ? (
          <p>Loading…</p>
        ) : phase === "signin" ? (
          <>
            <p>Sign in with your Tend account to connect it to your AI assistant.</p>
            <button onClick={handleSignIn}>Sign in with Google</button>
            <div className="divider">or</div>
            <form onSubmit={handlePasswordSignIn}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                required
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
              />
              {signInError && <p className="error small">{signInError}</p>}
              <button type="submit" className="secondary" disabled={signingIn}>
                {signingIn ? "Signing in…" : "Sign in with email"}
              </button>
            </form>
            <p className="account footnote">
              No account yet?{" "}
              <a href="https://friends.doneintentionally.com/signup" target="_blank" rel="noopener noreferrer">
                Create one first
              </a>
            </p>
          </>
        ) : (
          <>
            <p>An application wants to access your relationship manager.</p>
            <div className="scope">
              <strong>This will allow it to:</strong>
              <br />
              Read and write your contacts, events, and action items
            </div>
            <p className="account">
              Signed in as <strong>{session?.user.email}</strong>
              {" · "}
              <a onClick={handleSwitchAccount}>switch account</a>
            </p>
            <button onClick={handleApprove} disabled={phase === "working"}>
              {phase === "working" ? "Approving…" : "Approve"}
            </button>
            <button className="deny" onClick={handleDeny} disabled={phase === "working"}>
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8f8f8; }
  .wrap { display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
  .card { background: white; border-radius: 12px; padding: 2.5rem; max-width: 420px; width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #1a1a1a; }
  p { color: #666; margin-bottom: 1.5rem; line-height: 1.5; }
  .scope { background: #f0f4ff; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; text-align: left; color: #333; font-size: 0.9rem; }
  .scope strong { color: #4F46E5; }
  .account { font-size: 0.85rem; }
  .account a { color: #4F46E5; cursor: pointer; text-decoration: underline; }
  .error { color: #dc2626; }
  .error.small { font-size: 0.85rem; margin-bottom: 0.75rem; }
  .divider { display: flex; align-items: center; gap: 0.75rem; color: #999; font-size: 0.85rem; margin: 1.25rem 0; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #e5e5e5; }
  input { width: 100%; padding: 0.7rem 0.9rem; border: 1px solid #d4d4d4; border-radius: 8px; font-size: 0.95rem; margin-bottom: 0.75rem; }
  input:focus { outline: 2px solid #4F46E5; outline-offset: -1px; border-color: transparent; }
  .secondary { background: white; color: #1a1a1a; border: 1px solid #d4d4d4; }
  .secondary:hover { background: #f5f5f5; }
  .footnote { margin-top: 1.25rem; margin-bottom: 0; }
  button { background: #4F46E5; color: white; border: none; padding: 0.75rem 2rem; border-radius: 8px; font-size: 1rem; cursor: pointer; width: 100%; font-weight: 500; }
  button:hover { background: #4338CA; }
  button:disabled { opacity: 0.6; cursor: default; }
  .deny { background: none; color: #999; margin-top: 0.75rem; font-size: 0.85rem; }
  .deny:hover { color: #666; background: none; }
`;
