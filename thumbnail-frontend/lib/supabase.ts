import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function hasSupabaseAdminEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var: ${name}. Add it to thumbnail-frontend/.env.local (server-only) and restart \`npm run dev\`.`,
    );
  }
  return value;
}

/**
 * Server-side Supabase client intended for privileged writes.
 *
 * Use `SUPABASE_SERVICE_ROLE_KEY` only in server contexts (Server Actions, Route Handlers).
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const url = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
