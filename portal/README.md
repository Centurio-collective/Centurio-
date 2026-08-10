# Centurio Member Portal

Next.js (App Router, TypeScript) app for the Centurio Collective member
portal -- account/membership management, gated content, and the pieces
that the static marketing site (repo root) doesn't handle.

Deployed as its own Netlify site (base directory `portal`), separate
from the static site's deploy pipeline. Target domain:
**members.centuriocollective.com**.

## Stack

- Next.js 16 (App Router) + TypeScript
- Tailwind CSS
- Supabase (`@supabase/ssr` + `@supabase/supabase-js`) -- **same Supabase
  project as the main site** (`zjfyikiitcweyjszuonl`), not a separate one
- Stripe (`stripe`) -- server-side only, for the membership webhook work

## Getting started

```bash
cd portal
npm install
cp .env.example .env.local   # fill in NEXT_PUBLIC_SUPABASE_ANON_KEY at minimum
npm run dev
```

Open http://localhost:3000.

## Env vars

See `.env.example` for the full list and where each value comes from.
Notably:

- The Supabase **anon key** is safe in the browser (RLS-gated) and can go
  in `.env.local` for local dev.
- The Supabase **service role key** and Stripe **secret**/**webhook**
  keys are server-only secrets. Get them from their respective
  dashboards directly, never via chat/PR, and configure them on the
  Netlify site's env var settings for production -- not committed here.
- Stripe: develop against **test-mode** keys. The live cutover uses the
  same Stripe account as the main site's Payment Links (FD-038), not a
  separate account, and happens deliberately once webhook handling is
  verified.

## Structure

```
portal/
  app/                 App Router routes
  lib/supabase/
    client.ts          Browser client (Client Components)
    server.ts           Server client (Server Components/Actions, cookie-based)
    admin.ts            Service-role client (server-only, bypasses RLS)
  lib/stripe.ts         Server-side Stripe client
```
