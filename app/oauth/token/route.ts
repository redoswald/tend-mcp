import { verifyAuthCode, verifyPKCE } from "@/lib/oauth";
import { anonClient } from "@/lib/supabase";

/**
 * Token endpoint. Both grants resolve to a Supabase session: the access
 * token handed to MCP clients IS the user's Supabase JWT, so every query
 * made with it runs under RLS as that user.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";

  let grantType: string | null = null;
  let code: string | null = null;
  let codeVerifier: string | null = null;
  let redirectUri: string | null = null;
  let refreshToken: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await req.formData();
    grantType = body.get("grant_type") as string;
    code = body.get("code") as string;
    codeVerifier = body.get("code_verifier") as string;
    redirectUri = body.get("redirect_uri") as string;
    refreshToken = body.get("refresh_token") as string;
  } else {
    const body = await req.json();
    grantType = body.grant_type;
    code = body.code;
    codeVerifier = body.code_verifier;
    redirectUri = body.redirect_uri;
    refreshToken = body.refresh_token;
  }

  if (grantType === "authorization_code") {
    if (!code || !codeVerifier) {
      return errorResponse("invalid_request", "Missing code or code_verifier");
    }

    const secret = process.env.OAUTH_CODE_SECRET;
    if (!secret) {
      return errorResponse("server_error", "Server misconfigured");
    }

    const payload = await verifyAuthCode(code, secret);
    if (!payload) {
      return errorResponse("invalid_grant", "Invalid or expired authorization code");
    }

    if (redirectUri && redirectUri !== payload.redirectUri) {
      return errorResponse("invalid_grant", "redirect_uri mismatch");
    }

    const pkceValid = await verifyPKCE(codeVerifier, payload.codeChallenge);
    if (!pkceValid) {
      return errorResponse("invalid_grant", "PKCE verification failed");
    }

    return issueSession(payload.refreshToken);
  }

  if (grantType === "refresh_token") {
    if (!refreshToken) {
      return errorResponse("invalid_request", "Missing refresh_token");
    }
    return issueSession(refreshToken);
  }

  return errorResponse(
    "unsupported_grant_type",
    "Only authorization_code and refresh_token are supported"
  );
}

/**
 * Exchange a Supabase refresh token for a fresh session. GoTrue rotates
 * refresh tokens and handles reuse detection, so no server state is kept.
 */
async function issueSession(refreshToken: string) {
  const { data, error } = await anonClient().auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data.session) {
    return errorResponse("invalid_grant", "Session refresh failed — reauthorize");
  }

  const response = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    token_type: "Bearer",
    expires_in: data.session.expires_in,
    scope: "mcp:tools",
  };

  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function errorResponse(error: string, description: string) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
