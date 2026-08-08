# Centurio Collective — centuriocollective.com

Static site source for centuriocollective.com, plus the serverless
function that connects its two Netlify Forms to Supabase.

```
index.html, join.html, 1on1.html, score.html,
welcome.html, welcome-1on1.html, welcome-1on1-single.html,
privacy.html, terms.html            the site pages (no build step)
netlify/functions/form-webhook.js   Netlify Forms -> Supabase webhook
netlify.toml                        publish dir + functions config
package.json                        @supabase/supabase-js dependency
.env.example                        env var names (no real values)
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
