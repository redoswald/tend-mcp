# tend-mcp

Remote MCP server for [Tend](https://friends.doneintentionally.com), the Done Intentionally relationship manager. Lets any Tend user connect their own AI assistant to their contacts, events, and action items.

## Tools

`get_contacts`, `get_contact_detail`, `get_upcoming`, `get_social_summary`, `log_event`, `add_contact`, `update_contact`, `complete_action_item`, `update_event`, `delete_event`.

## Prompts

`social_review`, `log_catchup` — surfaced in the client's prompt picker.

## Auth

**Multi-user** OAuth 2.1 (PKCE, dynamic client registration, refresh tokens). Users sign in with their Tend account (Google or email) on the authorize page; the access token issued to the MCP client is their **Supabase session JWT**. Auth codes are stateless AES-256-GCM payloads (`lib/oauth.ts`) carrying the user's refresh token.

Unlike intend/portend, Tend's Prisma tables have no RLS, and ownership keys off the internal Prisma `User.id` (linked to auth via `User.supabaseId`). So this server keeps the **service-role client** and derives the caller's `User.id` per-request from the verified JWT (`resolveTendUserId` in `lib/supabase.ts`, auto-creating the row on first login) — the explicit `.eq("userId", …)` filters in every tool are the isolation layer, mirroring tend-web's own model.

## Connecting from claude.ai

Settings → Connectors → **Add custom connector** → this server's `/api/mcp` URL → sign in and approve.

## Environment

See `.env.example` — `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `OAUTH_CODE_SECRET`, plus `NEXT_PUBLIC_` URL/anon-key for the authorize page.

## Verify

```
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... \
  node scripts/verify-oauth.mjs <base_url> <email> <password> [foreign_event_id]
```

## Endpoint

`POST /api/mcp` — MCP streamable HTTP transport.
