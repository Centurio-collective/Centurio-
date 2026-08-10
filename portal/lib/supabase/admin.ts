import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Admin Supabase client using the service_role key -- bypasses Row Level
 * Security entirely.
 *
 * SERVER-ONLY. Never import this file from a Client Component, and never
 * let SUPABASE_SERVICE_ROLE_KEY be prefixed with NEXT_PUBLIC_. Use this
 * only in Route Handlers / Server Actions that need privileged access
 * (e.g. the Stripe webhook handler updating membership status on behalf
 * of a user who isn't the authenticated caller).
 */
export function createAdminClient() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. This client must only run server-side.",
    );
  }

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
