# Centurio — Netlify Forms → Supabase webhook

This repo currently contains the serverless function that connects
Netlify Forms submissions on **centuriocollective.com** to Supabase,
plus its deployment config. It does **not** yet contain the site's own
HTML/CSS/JS — see "What's not in this repo yet" below.

## What this does

`netlify/functions/form-webhook.js` receives a POST from a Netlify
Forms "outgoing webhook" notification, figures out which form was
submitted, and inserts the relevant fields into Supabase using the
`service_role` key (required because both tables have RLS enabled):

| Netlify form name       | Supabase table          | Columns inserted |
|--------------------------|--------------------------|-------------------|
| `waitlist`                | `waitlist_signups`        | `first_name`, `email` |
| `mental-fitness-score`    | `assessment_submissions`  | `name`, `email`, `overall_score`, `lead_score`, `align_score`, `regulate_score`, `connect_score`, `grow_score`, `perform_score` |

> **Field-name caveat:** the field names read from the submission
> (`first_name`, `email`, `name`, `overall_score`, ...) are assumed to
> match the `name` attributes on the live form's `<input>` elements.
> This function could not fetch the live site to verify that — double
> check the deployed form markup against `FORM_HANDLERS` in
> `netlify/functions/form-webhook.js` and adjust if the input names
> differ.

## What's not in this repo yet

The actual site source for centuriocollective.com isn't in this repo —
only this function and its deploy config. **Do not** point Netlify's
continuous (git-based) deploy at this repo as-is; because there's no
`publish` directory with real site content, a git-based deploy would
replace the live site with an empty one. Two safe ways to get this
function live instead:

1. **Merge into the existing site project.** Copy
   `netlify/functions/form-webhook.js`, the `@supabase/supabase-js`
   dependency, and the `[functions]` block from `netlify.toml` into
   whatever project/folder is currently used to produce the manual
   deploys for centuriocollective.com, then deploy that combined
   folder as usual.
2. **Migrate to git-based deploy properly.** Add the site's real HTML/
   CSS/JS into this repo (so it matches what's live today), then link
   this GitHub repo to the Netlify site (Site configuration → Build &
   deploy → Link repository) so Netlify builds/publishes from git
   going forward instead of manual uploads. Once that's done, this
   function ships automatically with every deploy.

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
function can read them at runtime. Redeploy after adding them —
env vars only take effect on the next deploy.

## 3. Deploy the function

See "What's not in this repo yet" above — merge this function into
your live site deploy (option 1) or migrate to git deploy with full
site content (option 2). Once deployed, its URL will be:

```
https://<your-site>.netlify.app/.netlify/functions/form-webhook
```

(or the equivalent path on `centuriocollective.com` once custom-domain
routing applies).

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

- Submit a test entry through each live form.
- Check **Functions → form-webhook → Logs** in the Netlify UI — a
  successful run logs
  `form-webhook: inserted "<form>" submission into "<table>"`; a
  failure logs the Supabase error or the missing-field list.
- Confirm the row landed in the corresponding Supabase table (Supabase
  dashboard → Table editor).

## Local reference

```
netlify/functions/form-webhook.js   the webhook handler
netlify.toml                        functions directory config
package.json                        @supabase/supabase-js dependency
.env.example                        env var names (no real values)
```
