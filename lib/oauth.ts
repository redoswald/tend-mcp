/**
 * Stateless OAuth helpers for multi-user MCP auth.
 *
 * Auth codes are AES-256-GCM encrypted payloads containing the client_id,
 * redirect_uri, code_challenge, the user's Supabase refresh token, and an
 * expiry. Encrypted rather than merely signed because the refresh token
 * transits the client's redirect URL. No server-side storage needed.
 */

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface AuthCodePayload {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  refreshToken: string;
  expiry: number;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createAuthCode(
  payload: Omit<AuthCodePayload, "expiry">,
  secret: string
): Promise<string> {
  const data = JSON.stringify({
    ...payload,
    expiry: Date.now() + AUTH_CODE_TTL_MS,
  } satisfies AuthCodePayload);

  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(data)
  );

  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function verifyAuthCode(
  code: string,
  secret: string
): Promise<AuthCodePayload | null> {
  const parts = code.split(".");
  if (parts.length !== 2) return null;

  try {
    const key = await deriveKey(secret);
    const iv = base64urlToBytes(parts[0]);
    const ciphertext = base64urlToBytes(parts[1]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    const payload = JSON.parse(
      new TextDecoder().decode(plaintext)
    ) as AuthCodePayload;

    if (Date.now() > payload.expiry) return null;
    return payload;
  } catch {
    // Wrong key, tampered ciphertext, or malformed payload
    return null;
  }
}

export async function verifyPKCE(
  codeVerifier: string,
  codeChallenge: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const computed = base64url(new Uint8Array(digest));
  return computed === codeChallenge;
}
