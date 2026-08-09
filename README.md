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
calculator that searches **two** free sources in parallel — USDA
FoodData Central (primary) and Open Food Facts (secondary, no key
needed, notably better for packaged/branded and AU products) — with
manual entry kept only as a fallback for foods neither source finds.

1. **Get a USDA FoodData Central API key** (skip if you already have
   the one from the prior build): https://fdc.nal.usda.gov/api-key-signup.html
   — free, no cost, just an email address. Open Food Facts needs no key
   or signup at all.
2. **Add the USDA key to Netlify**: Site configuration → Environment
   variables → add `USDA_API_KEY` with that value. Same rule as the
   Supabase key — never paste it into chat, commit it, or put it in
   client-side code. It's read server-side only, in
   `netlify/functions/food-search.js`.
3. Redeploy (env vars only take effect on the next deploy).
4. **Test the function directly** before trusting the UI:
   `https://centuriocollective.com/.netlify/functions/food-search?q=chicken%20breast%20cooked`
   should return `200` with a JSON body containing a merged `results`
   array (each item tagged `"source":"usda"` or `"source":"openfoodfacts"`)
   and a `sources` object showing both sources' status, e.g.
   `"sources":{"usda":{"ok":true,"count":8},"openFoodFacts":{"ok":true,"count":6}}`.
   If either source shows `"ok":false`, check **Functions →
   food-search → Logs** for the reason before touching the front end —
   a single source being down does *not* fail the whole request (see
   below), so check `sources` even on a `200`.
5. Then test the page itself: search a food, confirm results from both
   sources appear (each with its own source caption once added), and
   that editing grams updates the totals immediately.

### Multi-source design notes

- **Runs in parallel, degrades gracefully.** Both sources are queried
  with `Promise.allSettled`, each behind an 8s timeout. If one is slow,
  down, or misconfigured (e.g. `USDA_API_KEY` missing), the response is
  still `200` with whatever the healthy source returned — never a
  blanket failure because of one source. `sources.usda`/`sources.openFoodFacts`
  report each one's `ok`/`error`/`count` for debugging.
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
- **Open Food Facts data is ODbL-licensed**, which requires attribution
  when displayed publicly (USDA is US public domain, no such
  requirement, credited anyway). `nutrition.html` carries a permanent
  attribution line near the search box, and every Open-Food-Facts-sourced
  meal row is captioned with its source and barcode — never silently
  merged into "the database" with no provenance.

**What I could and couldn't verify myself:** I could not make a live
call to `api.nal.usda.gov` or `world.openfoodfacts.org` from this
sandbox (network egress is blocked here, same as it is to
centuriocollective.com) — the real USDA response (pasted back after
your live test) surfaced the kJ/kcal bug above, which is now fixed and
covered by a regression test. Local, no-network tests currently cover:
- `form-webhook.js`'s insert payload for both forms.
- `food-search.js`: missing-query 400; correct kcal (not kJ) extraction
  for both USDA and Open Food Facts against fixtures shaped like their
  real responses; graceful degradation when either source fails or
  `USDA_API_KEY` is missing (still `200`, still returns the healthy
  source's results).
- The full `nutrition.html` meal-calculator flow end-to-end in a real
  DOM (jsdom): search → results from both sources render with correct
  captions/attribution → select a USDA result → row added at 100g with
  correct readonly macros and a `USDA · <dataType> · fdcId <id>`
  caption → select an Open Food Facts result → captioned
  `Open Food Facts · <brand> · barcode <code>` instead → changing grams
  to 200 exactly doubles the row's macros → a second manually-added
  food sums into the meal total → removing a row also removes its
  caption → a search result with no usable nutrient data renders
  disabled rather than being added with fabricated zeros.

Live-test Open Food Facts the same way you tested USDA — search
something with strong AU packaged-food coverage (e.g. a Coles/Woolworths
branded item) and confirm the numbers look right before relying on it.

None of that substitutes for the handover doc's own acceptance tests
against the real USDA API and real deploy — do those (step 4 above)
before relying on this for real members.
