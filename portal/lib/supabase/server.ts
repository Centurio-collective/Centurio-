import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for use in Server Components, Route Handlers, and
 * Server Actions. Reads/writes the session via Next.js cookies so auth
 * state carries across server-rendered requests.
 *
 * Still uses the anon key -- RLS enforces access. Never import this
 * module's service-role counterpart into anything that ships to the
 * client.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // The `setAll` call will throw when invoked from a Server
            // Component that can't write cookies (e.g. during a static
            // render). Safe to ignore as long as middleware refreshes
            // the session -- see lib/supabase/middleware.ts (Slice work
            // that wires up auth should add this).
          }
        },
      },
    },
  );
}
