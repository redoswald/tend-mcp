import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { createId } from "@paralleldrive/cuid2";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let service: SupabaseClient<any, any, any> | null = null;

/**
 * Service-role client for Tend data. Unlike intend/portend, Tend's tables
 * have no RLS policies (they're deny-all through PostgREST; tend-web
 * enforces ownership with explicit userId filters in app code). The MCP
 * server mirrors that model: data access uses the service role, and the
 * per-request Prisma User.id — resolved from the caller's verified JWT in
 * verifyToken — is the isolation layer. Every query MUST filter by it.
 */
export function createClient() {
  if (service) return service;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service = createSupabaseClient<any, any, any>(url, key);
  return service;
}

/** Anon-key client, used only to validate bearer JWTs (auth.getUser). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function anonClient(): SupabaseClient<any, any, any> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment");
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface SupabaseAuthUser {
  id: string;
  email?: string;
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string };
}

/**
 * Map a verified Supabase auth user to Tend's Prisma User.id, creating the
 * row on first contact (mirrors tend-web's syncUserToPrisma: match by
 * supabaseId, then by email for pre-auth-migration rows, else insert).
 */
export async function resolveTendUserId(authUser: SupabaseAuthUser): Promise<string> {
  const db = createClient();

  const { data: bySupabaseId } = await db
    .from("User")
    .select("id")
    .eq("supabaseId", authUser.id)
    .maybeSingle();
  if (bySupabaseId) return bySupabaseId.id;

  if (!authUser.email) throw new Error("Authenticated user has no email");

  const { data: byEmail } = await db
    .from("User")
    .select("id")
    .eq("email", authUser.email)
    .maybeSingle();
  if (byEmail) {
    await db.from("User").update({ supabaseId: authUser.id }).eq("id", byEmail.id);
    return byEmail.id;
  }

  const now = new Date().toISOString();
  const { data: created, error } = await db
    .from("User")
    .insert({
      id: createId(),
      supabaseId: authUser.id,
      email: authUser.email,
      name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || null,
      avatarUrl: authUser.user_metadata?.avatar_url || null,
      updatedAt: now,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create Tend user: ${error.message}`);
  return created.id;
}
