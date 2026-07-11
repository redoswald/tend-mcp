import { createAuthCode } from "@/lib/oauth";
import { anonClient } from "@/lib/supabase";

/**
 * Called by the authorize page when the signed-in user clicks Approve.
 * Verifies the posted Supabase access token actually belongs to a live
 * session, then mints an encrypted auth code carrying the user's refresh
 * token for the token endpoint to redeem.
 */
export async function POST(req: Request) {
  const secret = process.env.OAUTH_CODE_SECRET;
  if (!secret) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    access_token: accessToken,
    refresh_token: refreshToken,
  } = body;

  if (!clientId || !redirectUri || !codeChallenge || !accessToken || !refreshToken) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { data, error } = await anonClient().auth.getUser(accessToken);
  if (error || !data.user) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }

  const code = await createAuthCode(
    {
      clientId,
      redirectUri,
      codeChallenge,
      userId: data.user.id,
      refreshToken,
    },
    secret
  );

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  return Response.json({ redirect: callbackUrl.toString() });
}
