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

## 6. Nutrition tool (`/nutrition.html`) — USDA food search setup

`nutrition.html` is a separate, unlinked page (per request — no link
from the main nav; you'll point a dedicated URL at it yourself). It has
a daily macro calculator (unchanged from the prototype) and a meal
calculator that now searches USDA FoodData Central first, with manual
entry kept only as a fallback for foods it can't find.

1. **Get a USDA FoodData Central API key** (skip if you already have
   the one from the prior build): https://fdc.nal.usda.gov/api-key-signup.html
   — free, no cost, just an email address.
2. **Add it to Netlify**: Site configuration → Environment variables →
   add `USDA_API_KEY` with that value. Same rule as the Supabase key —
   never paste it into chat, commit it, or put it in client-side code.
   It's read server-side only, in `netlify/functions/food-search.js`.
3. Redeploy (env vars only take effect on the next deploy).
4. **Test the function directly** before trusting the UI:
   `https://centuriocollective.com/.netlify/functions/food-search?q=chicken%20breast%20cooked`
   should return `200` with a JSON body like
   `{"query":"...","results":[{"fdcId":...,"description":"...","calories":...,"protein":...,"carbs":...,"fat":...,"fibre":...}, ...]}`.
   If it doesn't, check **Functions → food-search → Logs** before
   touching the front end (mirrors the handover doc's own troubleshooting order).
5. Then test the page itself: search a food, confirm results appear,
   select one, confirm it's added at 100g with the right macros, and
   that editing grams updates the totals immediately.

**What I could and couldn't verify myself:** I could not make a live
call to `api.nal.usda.gov` from this sandbox (network egress is
blocked here, same as it is to centuriocollective.com), so
`food-search.js`'s nutrient normalization is built to USDA's documented
`/foods/search` response shape but has not been exercised against a
real response. I did verify, with local tests (mocking both the
Supabase client and `fetch`, no network involved):
- `form-webhook.js`'s insert payload for both forms.
- `food-search.js`'s handler logic (missing-query 400, normalization
  shape).
- The full `nutrition.html` meal-calculator flow end-to-end in a real
  DOM (jsdom): search → select a result → adds a row at 100g with the
  correct per-100g macros, readonly on the USDA-sourced fields, a
  source caption (`USDA · <dataType> · fdcId <id>`) so provenance isn't
  lost; changing grams to 200 exactly doubles the row's macros; a
  second manually-added food sums into the meal total; removing a row
  also removes its source caption; a search result with no usable
  nutrient data renders disabled rather than being added with fabricated
  zeros.

None of that substitutes for the handover doc's own acceptance tests
against the real USDA API and real deploy — do those (step 4 above)
before relying on this for real members.
