# Centurio Collective — centuriocollective.com

Static site source for centuriocollective.com, plus the serverless
functions that connect its Netlify Forms to Supabase and power the
nutrition tool's food search.

```
index.html, join.html, 1on1.html, score.html,
welcome.html, welcome-1on1.html, welcome-1on1-single.html,
privacy.html, terms.html             the main site pages (no build step)
nutrition.html                       nutrition/macro calculator -- no nav link,
                                      reached only via its dedicated URL
netlify/functions/form-webhook.js    Netlify Forms -> Supabase webhook
netlify/functions/food-search.js     USDA FoodData Central search proxy
netlify.toml                         publish dir + functions config
package.json                         @supabase/supabase-js dependency
.env.example                         env var names (no real values)
```

## Forms → Supabase mapping

`netlify/functions/form-webhook.js` receives a POST from a Netlify
Forms "outgoing webhook" notification, figures out which form was
submitted, and inserts into Supabase using the `service_role` key
(required because both tables have RLS enabled). Field names below are
confirmed against the live form markup:

| Netlify form (`form_name`) | Form fields (`<input name="...">`) | Supabase table | Columns inserted |
|---|---|---|---|
| `waitlist` (index.html, 2 instances) | `name`, `email` | `waitlist_signups` | `first_name` ← `name`, `email` ← `email` |
| `mental-fitness-score` (score.html) | `name`, `email`, `score`, `lead_score`, `align_score`, `regulate_score`, `connect_score`, `grow_score`, `perform_score` | `assessment_submissions` | `name`, `email`, `overall_score` ← `score`, and the six `*_score` columns 1:1 |

Note the two renames: the waitlist form's `name` field feeds the
`first_name` column, and the assessment's `score` field feeds the
`overall_score` column — every other field matches its column name
directly.

## 1. Get the Supabase service role key (do this in the Supabase dashboard, not in chat)

1. Go to https://supabase.com/dashboard and open the project with ID
   `zjfyikiitcweyjszuonl`.
2. **Project Settings** (gear icon, bottom of left sidebar) → **API**.
3. Under "Project API keys", find the **`service_role`** key (marked
   `secret`) — not the `anon` / `public` key.
4. Click reveal/copy. Treat it like a database admin password:
   - Never paste it into a chat, commit it to git, or put it in
     client-side code.
   - It goes directly into Netlify's environment variables (next
     step) and nowhere else.

## 2. Set Netlify environment variables

In the Netlify UI: **Site configuration → Environment variables → Add
a variable**, and add both:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://zjfyikiitcweyjszuonl.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from step 1 |

Scope them to "All deploy contexts" (or at least Production) so the
function can read them at runtime. Redeploy after adding them — env
vars only take effect on the next deploy.

## 3. Link this repo to the Netlify site (switch from manual deploys to git deploys)

1. Netlify UI → your `centuriocollective.com` site → **Site
   configuration → Build & deploy → Continuous deployment → Link
   repository** (or "Link site to Git" if it currently shows no git
   source).
2. Choose GitHub → authorize/select the `Centurio-collective/Centurio-`
   repository → branch `claude/github-netlify-setup-pz7pxp` (or `main`,
   once this is merged there).
3. Build settings: **Build command** — leave blank. **Publish
   directory** — `.` (repo root). These match `netlify.toml`, so
   Netlify should pick them up automatically — just confirm they show
   correctly before saving.
4. Save. Netlify will run a deploy from this branch immediately.
5. **Check the deploy log** (Deploys tab → the new deploy) for two
   things before trusting it: it should list all 9 HTML pages as
   published, and it should show `form-webhook` under the Functions
   section as successfully bundled.

Once linked, every future push to the connected branch redeploys the
site automatically — no more manual uploads.

## 4. Configure the two outgoing webhooks in Netlify

Netlify Forms notifications are configured per-form. Repeat these
steps twice — once for `waitlist`, once for `mental-fitness-score`:

1. In the Netlify UI, go to **Site configuration → Forms → Form
   notifications**.
2. Click **Add notification → Outgoing webhook**.
3. **Event to listen for:** "New form submission".
4. **Form:** select `waitlist` (repeat later for
   `mental-fitness-score`).
5. **URL to notify:**
   `https://centuriocollective.com/.netlify/functions/form-webhook`
   (same URL both times — the function branches on `form_name`
   internally).
6. Save. Repeat steps 2–6 selecting the `mental-fitness-score` form.

## 5. Verify

- Load the live pages after the git-deploy switch and confirm they
  render exactly as before (nav, forms, styling) — since this deploy
  now serves from git instead of the previous manual upload, this is
  the check that nothing regressed.
- Submit a test entry through each live form.
- Check **Functions → form-webhook → Logs** in the Netlify UI — a
  successful run logs
  `form-webhook: inserted "<form>" submission into "<table>"`; a
  failure logs the Supabase error or the missing-field list.
- Confirm the row landed in the corresponding Supabase table (Supabase
  dashboard → Table editor).

## 6. Nutrition tool (`/nutrition.html`) — food search setup

`nutrition.html` is a separate, unlinked page (per request — no link
from the main nav; you'll point a dedicated URL at it yourself). It has
a daily macro calculator (unchanged from the prototype) and a meal
calculator that searches **three** free sources in parallel — USDA
FoodData Central, the Australian Food Composition Database (AFCD), and
Open Food Facts — with manual entry kept only as a fallback for foods
none of them find.

| Source | What it's for | Access |
|---|---|---|
| USDA FoodData Central | Generic/whole foods, US-centric | Free API key required |
| AFCD (FSANZ Release 3) | Generic foods incl. **standard butcher meats**, Australian conventions/cuts | Our own Supabase table (imported once — see §7) |
| Open Food Facts | Packaged/branded products, barcode data | No key/signup needed |

1. **Get a USDA FoodData Central API key** (skip if you already have
   the one from the prior build): https://fdc.nal.usda.gov/api-key-signup.html
   — free, no cost, just an email address. Open Food Facts needs no key
   or signup at all. AFCD setup is in §7 below (it's a one-time import,
   not a per-deploy step).
2. **Add the USDA key to Netlify**: Site configuration → Environment
   variables → add `USDA_API_KEY` with that value. Same rule as the
   Supabase key — never paste it into chat, commit it, or put it in
   client-side code. It's read server-side only, in
   `netlify/functions/food-search.js`.
3. Redeploy (env vars only take effect on the next deploy).
4. **Test the function directly** before trusting the UI:
   `https://centuriocollective.com/.netlify/functions/food-search?q=chicken%20breast%20cooked`
   should return `200` with a JSON body containing a merged `results`
   array (each item tagged `"source":"usda"`, `"source":"afcd"`, or
   `"source":"openfoodfacts"`) and a `sources` object showing all three
   sources' status, e.g.
   `"sources":{"usda":{"ok":true,"count":8},"afcd":{"ok":true,"count":6},"openFoodFacts":{"ok":true,"count":8}}`.
   If any source shows `"ok":false`, check **Functions →
   food-search → Logs** for the reason before touching the front end —
   a single source being down does *not* fail the whole request (see
   below), so check `sources` even on a `200`.
5. Then test the page itself: search a food, confirm results from both
   sources appear (each with its own source caption once added), and
   that editing grams updates the totals immediately.

### Multi-source design notes

- **Runs in parallel, degrades gracefully.** All three sources are
  queried with `Promise.allSettled`, each behind an 8s timeout (AFCD's
  Supabase RPC call included). If one is slow, down, or misconfigured
  (e.g. `USDA_API_KEY` or `SUPABASE_ANON_KEY` missing), the response is
  still `200` with whatever the healthy sources returned — never a
  blanket failure because of one. `sources.usda`/`sources.afcd`/
  `sources.openFoodFacts` each report `ok`/`error`/`count` for debugging.
- **The same kcal/kJ trap exists in both APIs.** USDA reports "Energy"
  twice (kcal *and* kJ, same nutrient name) — this already caused a
  live bug here (690 kJ read as if it were 165 kcal) fixed by matching
  on nutrient ID first. Open Food Facts has the same duplication
  (`energy_100g` is kJ, `energy-kcal_100g` is kcal) — `food-search.js`
  explicitly reads the kcal-suffixed field for that reason.
- **Open Food Facts requires a descriptive `User-Agent`** per their API
  usage policy — a generic one risks being rate-limited. Set in
  `food-search.js` (`OFF_USER_AGENT`); update the contact info there if
  it should point somewhere other than centuriocollective.com.
- **Open Food Facts is French-heaviest by default, confirmed live.** A
  real test query ("chicken breast cooked") returned only French deli
  brands (Fleury Michon, Herta, Carrefour) — zero AU products — because
  OFF's global search isn't locale-aware and it has the most
  contributors/data in France. First fix attempt ran two parallel OFF
  requests per search (one country-filtered, one global) — that doubled
  load on OFF's older `cgi/search.pl` endpoint and started producing
  live `503`s, confirmed by a follow-up live test. Reverted to a
  **single** request (the one already proven reliable), just requesting
  the extra `countries_tags` field and sorting AU-tagged products first
  locally — same "AU products surface first when present" outcome, no
  second request, no added load on OFF. Still a soft priority, not a
  hard filter: country tagging is inconsistent on OFF, so nothing gets
  dropped just for lacking a country tag. Worth re-testing with an
  AU-brand query (Coles/Woolworths) to see how much this actually
  improves it, now that it won't risk 503ing the whole source.

  Confirmed live after the single-request fix: no more 503s, rounding
  is clean, but "chicken breast cooked" still came back all-French —
  because OFF only requested its own top 8 by relevance before
  sorting, and if an AU product ranks outside that top 8 in OFF's own
  ranking, the sort never even sees it. Tried requesting a deeper pool
  (`page_size=24`) in the same single request to give the sort more to
  work with — **this also 503'd live.** Two separate attempts to get
  more out of this endpoint (a second parallel request, then a larger
  page_size) each broke it in production. That's not bad luck twice —
  it means OFF's legacy `cgi/search.pl` endpoint is fragile to
  anything beyond the exact minimal shape that's worked reliably:
  `page_size=8`, no extra filter params. **Reverted for good** —
  `OFF_CANDIDATE_POOL_SIZE` is now pinned to `PAGE_SIZE_PER_SOURCE`
  (8), with a test asserting `page_size` stays `8` so this doesn't get
  re-attempted by accident. AU-tagged products still sort to the front
  *within* whatever those 8 results are, but a match ranked outside
  OFF's own top 8 is out of reach — an accepted trade-off for not
  breaking the source again. If AU coverage needs to be better than
  "whatever happens to be in OFF's top 8," that's the point to reach
  for the NUTTAB/AFCD import instead of tuning this endpoint further.
- **Open Food Facts nutrient values are noisy.** Real data came back as
  `103.967495219885` kcal/100g (crowdsourced, likely back-computed from
  a per-serving figure) — `food-search.js` now rounds OFF's calories to
  the nearest whole number and other macros to 1 decimal before they
  ever reach the UI, so nothing that precise-looking lands in an
  editable field.
- **Open Food Facts data is ODbL-licensed**, which requires attribution
  when displayed publicly (USDA is US public domain, no such
  requirement, credited anyway). `nutrition.html` carries a permanent
  attribution line near the search box, and every Open-Food-Facts-sourced
  meal row is captioned with its source and barcode — never silently
  merged into "the database" with no provenance.
- **AFCD is our own Supabase table, not a live external API** — see §7
  for the import. Because of that it doesn't share USDA/OFF's
  reliability risk (no third-party endpoint to break), and it's queried
  with the anon/publishable key rather than the service role: it's
  public read-only reference data behind an RLS policy that already
  permits anon `SELECT`, so there's no reason to use a key that bypasses
  RLS (that's reserved for `form-webhook.js`'s inserts). AFCD also has
  the same kJ-only energy figure as the others (no kcal column at all in
  the source data) — converted once at import time and stored alongside
  the original kJ value for traceability. Search uses `pg_trgm` trigram
  similarity rather than substring matching, because AFCD's
  comma-separated naming convention ("Chicken, breast, lean flesh,
  baked, no added fat") means a natural query like "chicken breast
  cooked" almost never appears as one contiguous substring — an early
  version of the search function required exact substring containment
  and returned zero results for realistic queries before this was
  caught and fixed. AFCD data is CC BY-SA 3.0 Australia licensed
  (attribution + share-alike) — credited on `nutrition.html` alongside
  the USDA/OFF lines, and each AFCD-sourced meal row is captioned with
  FSANZ's own data-quality signal for that food (`Analysed` / `Recipe` /
  `Borrowed` / `Imputed` / `Label Data` / `Estimated`) so a lab-measured
  figure isn't presented with the same implied confidence as an
  estimated one.

## 7. AFCD one-time import (already done — for reference/re-running only)

Unlike USDA/OFF, AFCD isn't a live API call per search — it's a
Supabase table (`public.afcd_foods`, 1,588 rows) imported once from the
FSANZ-published Release 3 Excel file you provided. This section is for
reference (what was done and why) and for re-running the import if the
data ever needs refreshing from a newer FSANZ release.

1. **Schema**: `public.afcd_foods` (public_food_key, classification,
   derivation, food_name, energy_kj, calories_kcal, protein_g, carbs_g,
   fat_g, fibre_g) with RLS enabled and a public-read policy (`anon`,
   `authenticated`) — no insert/update/delete policy for anon, so the
   table can only be written to via an admin-run import (service role
   or dashboard), never at request time.
2. **Search function**: `public.search_afcd_foods(search_query text,
   result_limit int)` — a `pg_trgm` trigram-similarity search over
   `food_name`, threshold `0.15`, granted `EXECUTE` to `anon`. Verified
   directly against the live table (not a fixture) with real queries —
   "chicken breast cooked", "beef mince", "lamb chop", "salmon fillet"
   all returned correctly-ranked matches; a nonsense query returned
   nothing.
3. **Add `SUPABASE_ANON_KEY` to Netlify**: Site configuration →
   Environment variables → add `SUPABASE_ANON_KEY` with the
   anon/publishable key from Supabase (Project Settings → API — either
   the legacy `anon` JWT or the newer `sb_publishable_...` key works).
   This is **not** the service role key — it's meant to be public,
   gated only by the RLS policy above, so the usual "never expose this"
   warning doesn't apply the same way here, but it still shouldn't be
   hardcoded client-side; read server-side in `food-search.js` like the
   other keys.
4. Redeploy, then re-test the function URL from §6 step 4 and confirm
   `sources.afcd.ok` is `true` with a non-zero `count`.

**Re-running the import** (only needed if FSANZ publishes a newer
release): re-run the same extraction/load process against the new
Excel file — `public_food_key` is the natural primary key, so a
straightforward re-import (truncate + reload, or upsert on
`public_food_key`) keeps things consistent.

## What I could and couldn't verify myself

I could not make a live call to `api.nal.usda.gov` or
`world.openfoodfacts.org` from this sandbox (network egress is blocked
here, same as it is to centuriocollective.com) — the real USDA response
(pasted back after your live test) surfaced the kJ/kcal bug above,
which is now fixed and covered by a regression test. **AFCD is
different**: since it's our own Supabase table, I *could* and did
verify it directly against the live database (not just fixtures) —
schema, all 1,588 rows loaded with no duplicates/missing nutrients, the
search function's ranking, and the chicken-breast rows byte-for-byte
against the source spreadsheet.

Local, no-network tests currently cover:
- `form-webhook.js`'s insert payload for both forms.
- `food-search.js`: missing-query 400; correct kcal (not kJ) extraction
  for USDA, AFCD, and Open Food Facts against fixtures shaped like their
  real responses/rows (AFCD fixture uses string-typed numeric columns,
  matching real Postgres-via-postgrest behavior, to catch a missing
  `Number()` coercion); graceful degradation when any source fails,
  errors, or its required env var is missing (still `200`, still
  returns the healthy sources' results); the derivation-in-dataType
  folding for AFCD captions.
- The full `nutrition.html` meal-calculator flow end-to-end in a real
  DOM (jsdom): search → results from all three sources render with
  correct captions/attribution → select a USDA result → row added at
  100g with correct readonly macros and a `USDA · <dataType> · fdcId
  <id>` caption → select an Open Food Facts result → captioned
  `Open Food Facts · <brand> · barcode <code>` instead → select an AFCD
  result → captioned `AFCD · <derivation> · food key <key>` instead →
  changing grams to 200 exactly doubles the row's macros → a second
  manually-added food sums into the meal total → removing a row also
  removes its caption → a search result with no usable nutrient data
  renders disabled rather than being added with fabricated zeros.

Live-test Open Food Facts the same way you tested USDA — search
something with strong AU packaged-food coverage (e.g. a Coles/Woolworths
branded item) and confirm the numbers look right before relying on it.

None of that substitutes for the handover doc's own acceptance tests
against the real USDA API and real deploy — do those (step 4 above)
before relying on this for real members.
