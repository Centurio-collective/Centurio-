// netlify/functions/form-webhook.js
//
// Receives Netlify Forms "outgoing webhook" notifications and writes the
// submitted data into the matching Supabase table.
//
// Configure this as the target for the outgoing webhooks in Netlify
// (Site settings -> Forms -> Form notifications -> Outgoing webhook), one
// per form ("waitlist", "mental-fitness-score", "affiliate-application",
// "corporate-enquiry", "snapshot-request", "brand-partner", "pt-masterclass").
// All point at the same function URL; the function branches on form_name.
//
// pt-masterclass (PROMPT_63, revised PROMPT_64): the confirmation email
// must reach someone within a minute of registering, not wait up to an
// hour for the portal's hourly cron, since a trainer who registers
// shortly before a 7:30pm session cannot afford that wait. So it pings
// the portal immediately, the same shape as mental-fitness-score and
// waitlist's own email 1 triggers, on every successful write -- an
// insert OR an update, since someone re registering for a LATER session
// date is owed a new confirmation too, which the portal's own ledger
// (keyed on registration id, email key AND session date) is what
// actually decides, not this function.
//
// Required environment variables (set in Netlify: Site settings ->
// Environment variables):
//   SUPABASE_URL              e.g. https://zjfyikiitcweyjszuonl.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY the service_role secret key (NEVER the anon key)
//   ASSESSMENT_NOTIFY_SECRET  shared secret, must match the portal's value
//                             exactly, or the assessment nurture sequence's
//                             first email never fires
//   WAITLIST_NOTIFY_SECRET    the same, for the waitlist nurture sequence.
//                             A SEPARATE secret by design: every trust
//                             boundary in this system has its own, none are
//                             shared. Must match the portal's value exactly
//                             or the waitlist welcome email never fires
//   MASTERCLASS_NOTIFY_SECRET the same, for the PT Masterclass confirmation
//                             email. Also its own secret, not shared with
//                             any of the other two. Must match the portal's
//                             value exactly or the confirmation never fires
//   SENTRY_DSN                optional. Dormant until set, same convention
//                             as the portal (sentry.server.config.ts). Set
//                             it to the same project the portal reports to
//                             so a broken consent write is visible from
//                             either side of the trust boundary -- see
//                             PROMPT_60, Fault 1.
//
// The service role key is required (not the anon key) because both target
// tables have Row Level Security enabled and no insert policy for
// anonymous/public callers -- only the service role bypasses RLS. This key
// must only ever live in Netlify's server-side environment variables; it is
// never sent to or used by the browser.

const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASSESSMENT_NOTIFY_SECRET = process.env.ASSESSMENT_NOTIFY_SECRET;

// PROMPT_60. A broken consent write used to be a console.error swallowed
// by Netlify's own logs and nothing else -- the exact reason Fault 1 ran
// undetected for every submission between 2 November and this fix. init()
// is a no-op without SENTRY_DSN, same as the portal, so this function
// behaves identically in any environment that has not set it.
//
// Sentry.captureException/captureMessage below only queue an event; they
// do not send it. A Netlify function has nothing keeping the process
// alive after the handler returns to deliver a queued event on its own,
// so exports.handler calls Sentry.flush() exactly once, right before its
// own return, to cover every event queued anywhere during the call.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
}

// The portal endpoint that sends email 1 of the assessment nurture
// sequence immediately, rather than waiting for the next daily cron pass.
// Overridable so this can be pointed at a preview deployment for testing.
const NOTIFY_URL =
  process.env.ASSESSMENT_NOTIFY_URL ||
  'https://members.centuriocollective.com/api/nurture/notify';

const WAITLIST_NOTIFY_SECRET = process.env.WAITLIST_NOTIFY_SECRET;

// The portal endpoint that sends the PT Masterclass confirmation
// immediately (PROMPT_64), rather than waiting for the next hourly cron
// pass. Overridable for pointing at a preview deployment while testing.
const MASTERCLASS_NOTIFY_SECRET = process.env.MASTERCLASS_NOTIFY_SECRET;
const MASTERCLASS_NOTIFY_URL =
  process.env.MASTERCLASS_NOTIFY_URL ||
  'https://members.centuriocollective.com/api/nurture/masterclass-notify';

// The portal endpoint that sends the waitlist welcome immediately, rather
// than waiting for the next daily cron pass. A welcome email that arrives
// up to a day late is a welcome email nobody reads, which is the whole
// reason this trigger exists rather than leaving it to the cron.
const WAITLIST_NOTIFY_URL =
  process.env.WAITLIST_NOTIFY_URL ||
  'https://members.centuriocollective.com/api/nurture/waitlist-notify';

// ---------------------------------------------------------------------
// Marketing consent
// ---------------------------------------------------------------------
//
// Under the Spam Act 2003 an email address handed over to receive an
// assessment score is consent to send the score. It is NOT consent to send
// an ongoing marketing sequence, and ACMA's 2024 Statement of Expectations
// prohibits bundled consent and pre-ticked boxes. So the results page
// carries a separate, unticked checkbox, and what a person agreed to is
// stored per row.
//
// The wording is resolved HERE, from a posted version number, rather than
// being read out of a hidden field carrying the text itself. A hidden
// field is client-side and editable, which would make the stored record of
// what someone consented to forgeable -- and that record is exactly the
// thing that has to survive a complaint.
//
// NEVER EDIT AN EXISTING VERSION. Change the wording, add v2. Rewriting v1
// would silently restate what past consenters agreed to. This map is
// mirrored in the portal at lib/email/assessment-copy.ts (CONSENT_TEXT) so
// the wording can be read back from either side.
const CONSENT_TEXT = {
  v1: 'Send me the Centurio email. Ideas on training the six capacities, roughly weekly. Unsubscribe any time.',
  // v2, 2026-09-13. v1 promised a weekly ongoing email. What actually
  // gets sent is four emails over twelve days and then nothing, so v1
  // described a newsletter that does not exist. Under the Spam Act the
  // consent text IS the record of what the person agreed to, which makes
  // an inaccurate one a compliance problem rather than only a marketing
  // one. v2 describes what actually happens.
  //
  // The same wording is used by this checkbox and by the consent link in
  // the result email, so there is one thing being agreed to and one
  // version recording it.
  v2: 'Send me the follow up. A few short emails over the next couple of weeks, one idea each, on the capacity you scored lowest on. Unsubscribe any time.',
  // v3, 2026-09-18. Shorter, and consistently in the visitor's own
  // first person voice throughout rather than switching between "me"
  // and "you" mid sentence. The general unsubscribe assurance stays on
  // the page itself (the line under the submit button), not repeated
  // inside every version of this checkbox text.
  v3: 'Send me the complimentary follow up to strengthen the capacity I scored lowest on.',
  // v4, 2 November 2026. The opt in checkbox was removed. Everyone who
  // taps See My Results now gives marketing consent, via a statement
  // (id="consentStatement" in score.html) that sits above the fields in
  // readable type rather than inside a box to tick. This map's own
  // comment already explains why the wording lives here rather than in
  // a posted field: posted text is forgeable, and this is the record
  // that has to survive a complaint. This entry was the one actually
  // missing when the page shipped v4, which is why every submission
  // since 2 November recorded no consent at all -- PROMPT_60.
  v4: 'Enter your details to see your full Mental Fitness Score and get your personalised PDF report. Centurio will also email you one practice a week for the capacity you scored lowest on. Unsubscribe any time.',
};

const FORM_HANDLERS = {
  waitlist: {
    table: 'waitlist_signups',
    map: (data) => ({
      first_name: str(data.name),
      email: str(data.email),
      // Attribution, added 2026-09-22. The waitlist campaign was driving
      // signups with no record of which ad produced them. Same nine
      // fields as the assessment, mapped through the same helper, so the
      // two tables stay directly comparable.
      ...attribution(data),
      // Which entry point, added 2026-09-25 when the score results page
      // became the second one. "home" or "score". Everything before this
      // date is null and was the home page.
      source: str(data.source),
      // Set when the person reached the score through a partner's
      // co-branded link, so a seat held is credited the same way a
      // membership is.
      partner_code: str(data.partner_code),
    }),
    required: ['first_name', 'email'],
  },
  'mental-fitness-score': {
    table: 'assessment_submissions',
    map: (data) => {
      const consent = bool(data.marketing_consent);
      const version = str(data.consent_version);
      const text = consent && version ? CONSENT_TEXT[version] : null;

      // Consent we cannot evidence is consent we will not rely on. The
      // only way to reach here with a ticked box and an unknown version is
      // a deploy mismatch, where the page moved to v2 and this function
      // did not. Recording the consent anyway would leave a row asserting
      // agreement to wording nobody can produce; recording it as false
      // costs one subscriber and is defensible. The console error is the
      // signal to fix the mismatch.
      if (consent && !text) {
        const message = `form-webhook: marketing consent ticked with unknown consent_version "${version}", recording as NO consent`;
        console.error(message);
        // PROMPT_60, Fault 1. This exact branch, silent beyond the Netlify
        // function log above, is why 14 submissions recorded no consent
        // after the results page moved to a version this map had not yet
        // learned. A write that silently drops consent must be visible.
        Sentry.captureMessage(message, { level: 'error', extra: { version, email: str(data.email) } });
      }

      const consented = consent && Boolean(text);

      return {
        name: str(data.name),
        email: str(data.email),
        overall_score: num(data.score),
        lead_score: num(data.lead_score),
        align_score: num(data.align_score),
        regulate_score: num(data.regulate_score),
        connect_score: num(data.connect_score),
        grow_score: num(data.grow_score),
        perform_score: num(data.perform_score),
        responses: jsonObject(data.responses),
        // Attribution. Every field null safe through str(), because an
        // organic visitor carries none of them and that is the normal
        // case, not an error. Nothing here may ever fail a submission.
        ...attribution(data),
        // Which partner's co-branded link this person came through, and
        // which discount their report carried. partner_code joins to
        // brand_partners.partner_code; both are null for an organic
        // completer, which is the normal case.
        partner_code: str(data.partner_code),
        partner_discount_code: str(data.partner_discount_code),
        marketing_consent: consented,
        marketing_consent_at: consented ? new Date().toISOString() : null,
        marketing_consent_text: consented ? text : null,
        // Which wording, and where it was given. Consent can now also be
        // given by a link in the result email, and the two are counted
        // separately: roughly two thirds of completers do not tick this
        // box, and whether asking again in the email recovers them is the
        // entire question this records the answer to.
        marketing_consent_version: consented ? version : null,
        marketing_consent_source: consented ? 'results_page' : null,
      };
    },
    required: ['name', 'email'],
  },
  'corporate-enquiry': {
    table: 'corporate_enquiries',
    map: (data) => ({
      company_name: str(data.company_name),
      contact_name: str(data.contact_name),
      email: str(data.email),
      role: str(data.role),
      phone: str(data.phone),
      team_size: str(data.team_size),
      location: str(data.location),
      timing: str(data.timing),
      follow_through: str(data.follow_through),
      notes: str(data.notes),
    }),
    required: ['company_name', 'contact_name', 'email'],
  },
  // The October 2026 campaign. Free team snapshot, offered for one month
  // against Mental Health Month and National Safe Work Month. Kept in its
  // own table rather than folded into corporate_enquiries because the
  // whole point of the campaign is measuring whether a free instrument
  // out-converts a direct program enquiry, and that comparison is only
  // possible while the two stay separate.
  'snapshot-request': {
    table: 'snapshot_requests',
    map: (data) => ({
      company_name: str(data.company_name),
      contact_name: str(data.contact_name),
      email: str(data.email),
      role: str(data.role),
      phone: str(data.phone),
      team_size: str(data.team_size),
      location: str(data.location),
      notes: str(data.notes),
      ...attribution(data),
    }),
    required: ['company_name', 'contact_name', 'email'],
  },
  // Consumer brand partners (supplements, activewear, ready to eat meals).
  // Same 10 and 10 commercial model as the gym affiliates, kept in its own
  // table because the audience, the assets and the sales conversation differ,
  // and folding them together would make either one impossible to measure.
  'brand-partner': {
    table: 'brand_partners',
    map: (data) => ({
      brand_name: str(data.brand_name),
      contact_name: str(data.contact_name),
      email: str(data.email),
      role: str(data.role),
      phone: str(data.phone),
      category: str(data.category),
      audience_size: str(data.audience_size),
      website: str(data.website),
      notes: str(data.notes),
      ...attribution(data),
    }),
    required: ['brand_name', 'contact_name', 'email'],
  },
  'affiliate-application': {
    table: 'affiliate_applications',
    map: (data) => ({
      gym_name: str(data.gym_name),
      contact_name: str(data.contact_name),
      email: str(data.email),
      phone: str(data.phone),
      suburb: str(data.suburb),
      member_count: str(data.member_count),
      website: str(data.website),
      notes: str(data.notes),
      ...attribution(data),
    }),
    required: ['gym_name', 'contact_name', 'email'],
  },
  // Personal trainers, coaches and studio owners. Separate from the gym
  // affiliates because the commercial model is different (30 percent of the
  // membership rather than the 10 and 10), the person applying is usually a
  // sole operator rather than a business, and the number that matters about
  // them is a client count, not a member count.
  'trainer-application': {
    table: 'trainer_applications',
    map: (data) => ({
      trainer_name: str(data.trainer_name),
      email: str(data.email),
      phone: str(data.phone),
      business_name: str(data.business_name),
      suburb: str(data.suburb),
      client_count: str(data.client_count),
      instagram: str(data.instagram),
      website: str(data.website),
      notes: str(data.notes),
      ...attribution(data),
    }),
    required: ['trainer_name', 'email'],
  },
  // PROMPT_63. The free weekly PT Masterclass, masterclass.html, posting
  // the "pt-masterclass" form. UPSERT, not insert: a trainer who
  // registers a second time is an update to the same row, not a
  // duplicate, so this is the one handler with upsertKey set -- see
  // upsertByLowerEmail below for why that needs its own code path
  // rather than the plain insert every other handler uses.
  //
  // Consent is written from the posted values, never resolved from a
  // version map the way mental-fitness-score's is -- the brief for this
  // form is explicit that marketing_consent_text is stored verbatim,
  // because storing the sentence the person actually read is the whole
  // point of that column.
  'pt-masterclass': {
    table: 'masterclass_registrations',
    upsertKey: 'email',
    map: (data) => {
      const consented = str(data.marketing_consent) === 'yes';
      return {
        name: str(data.name),
        email: str(data.email),
        gym: str(data.gym),
        client_count: str(data.client_count),
        ...attribution(data),
        marketing_consent: consented,
        marketing_consent_at: consented ? new Date().toISOString() : null,
        marketing_consent_source: consented ? 'masterclass_page' : null,
        marketing_consent_version: consented ? str(data.consent_version) : null,
        marketing_consent_text: consented ? str(data.marketing_consent_text) : null,
      };
    },
    required: ['name', 'email'],
  },
};

/**
 * Escapes the two ilike wildcard characters (and the escape character
 * itself) so an ilike comparison behaves as a case insensitive EQUALS
 * rather than a pattern match. Used only to find a masterclass
 * registration by lower(email) -- see upsertByLowerEmail below.
 */
function escapeIlike(value) {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

/**
 * masterclass_registrations is unique on lower(email), a functional
 * index, not on the email column itself -- so Supabase's own
 * .upsert({ onConflict: 'email' }) cannot target it; PostgREST's
 * onConflict only matches a constraint by its literal column list, and
 * "email" does not textually match "lower(email)". This does the same
 * job in two steps instead: find the existing row case insensitively
 * (ilike with no wildcards in the search value behaves as case
 * insensitive equality), then update it if found, insert if not.
 *
 * The 23505 fallback below closes the one real race this introduces:
 * two submissions for the same address landing close enough together
 * that both run the SELECT before either runs the INSERT. The second
 * INSERT then fails on the unique index rather than silently creating a
 * duplicate, and is retried as an update rather than surfaced as an
 * error -- a genuine race resolving to one row with the second
 * submission's data, which is the correct outcome either way.
 */
async function upsertByLowerEmail(client, table, emailField, row) {
  const emailValue = row[emailField];
  const emailLower = emailValue.toLowerCase();

  const { data: existing, error: selectError } = await client
    .from(table)
    .select('id')
    .ilike(emailField, escapeIlike(emailLower))
    .limit(1)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing) {
    const { data: updated, error: updateError } = await client
      .from(table)
      .update({ ...row, last_registered_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('id')
      .single();
    if (updateError) throw updateError;
    return { id: updated.id, action: 'updated' };
  }

  const { data: inserted, error: insertError } = await client.from(table).insert(row).select('id').single();

  if (insertError && insertError.code === '23505') {
    // Lost the race between the SELECT above and this INSERT -- someone
    // else's submission for the same address landed in between. Fall
    // back to the update path rather than erroring the webhook.
    const { data: retryExisting, error: retrySelectError } = await client
      .from(table)
      .select('id')
      .ilike(emailField, escapeIlike(emailLower))
      .limit(1)
      .maybeSingle();
    if (retrySelectError || !retryExisting) throw insertError;

    const { data: updated, error: updateError } = await client
      .from(table)
      .update({ ...row, last_registered_at: new Date().toISOString() })
      .eq('id', retryExisting.id)
      .select('id')
      .single();
    if (updateError) throw updateError;
    return { id: updated.id, action: 'updated' };
  }

  if (insertError) throw insertError;
  return { id: inserted.id, action: 'inserted' };
}

// The nine attribution fields, mapped in one place so the assessment
// and anything added later cannot drift apart on which of them exist
// or how an absent one is recorded. str() turns an empty string into
// null, which is what a column with no attribution should hold: null
// means no attribution, not an empty attribution.
//
// fbclid and gclid are click identifiers the person's own click
// carried. fbclid in particular is the only value that joins a row
// back to a specific Meta ad click, and is what the Conversions API
// needs to construct its fbc parameter.
const ATTRIBUTION_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid', 'referrer', 'landing_url',
];

function attribution(data) {
  const out = {};
  for (const field of ATTRIBUTION_FIELDS) out[field] = str(data[field]);
  return out;
}

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// An unticked checkbox is omitted entirely from a form post, so absent has
// to mean false rather than unknown -- str() and num() both return null
// here, which is wrong for a NOT NULL DEFAULT false column. Truthy values
// are matched explicitly rather than by JS truthiness, because the string
// "false" is truthy and would otherwise record the opposite of what the
// person chose.
function bool(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'on' || s === 'true' || s === '1';
}

// Netlify form fields are strings, so the responses object arrives JSON
// encoded. Parsed defensively: a malformed value must cost the responses
// and nothing else, because losing a submission entirely would be worse
// than losing the detail this column exists to add.
function jsonObject(v) {
  if (v === undefined || v === null || v === '') return null;
  try {
    const parsed = typeof v === 'object' ? v : JSON.parse(String(v));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error('form-webhook: could not parse responses as JSON', err.message);
    return null;
  }
}

// Netlify's outgoing webhook body is JSON. The submission payload has
// historically been sent either as the top-level object, or nested under a
// `payload` key depending on notification type -- handle both shapes so a
// Netlify-side format change doesn't silently break inserts.
function extractSubmission(body) {
  const root = body && typeof body === 'object' ? body : {};
  const payload = root.payload && typeof root.payload === 'object' ? root.payload : root;
  return {
    formName: payload.form_name || payload.formName || null,
    data: payload.data && typeof payload.data === 'object' ? payload.data : {},
  };
}

let supabase;
function getSupabaseClient() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable(s).'
      );
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

// Fire-and-forget trigger for email 1. Deliberately takes only the
// submission id: the portal reads the email address off the row, because
// an endpoint that emails whatever address it is handed is an open relay
// for Centurio-branded mail.
//
// Failures here are logged and swallowed on purpose. See the handler
// below for why this must never turn into a non-2xx response.
async function triggerResultEmail(submissionId) {
  if (!ASSESSMENT_NOTIFY_SECRET) {
    console.error('form-webhook: ASSESSMENT_NOTIFY_SECRET is not set, cannot trigger email 1');
    return;
  }

  try {
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ASSESSMENT_NOTIFY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ submissionId }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`form-webhook: notify returned ${res.status}: ${body}`);
      return;
    }

    console.log(`form-webhook: triggered email 1 for submission ${submissionId}`);
  } catch (err) {
    console.error('form-webhook: notify call failed:', err.message);
  }
}

// Same contract as triggerResultEmail above, and for the same reason:
// takes only the new row id, never an email address, because an endpoint
// that emails whatever address it is handed is an open relay for
// Centurio-branded mail. Failures logged and swallowed identically.
async function triggerWaitlistWelcome(signupId) {
  if (!WAITLIST_NOTIFY_SECRET) {
    console.error('form-webhook: WAITLIST_NOTIFY_SECRET is not set, cannot trigger the waitlist welcome');
    return;
  }

  try {
    const res = await fetch(WAITLIST_NOTIFY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAITLIST_NOTIFY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ signupId }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`form-webhook: waitlist notify returned ${res.status}: ${body}`);
      return;
    }

    console.log(`form-webhook: triggered the waitlist welcome for signup ${signupId}`);
  } catch (err) {
    console.error('form-webhook: waitlist notify call failed:', err.message);
  }
}

// Same contract as triggerResultEmail/triggerWaitlistWelcome above, and
// for the same reason: takes only the registration row id, never an
// email address, because an endpoint that emails whatever it is handed
// is an open relay for Centurio branded mail. Failures logged and
// swallowed identically -- the insert or update has already succeeded
// by the time this runs, so a failed trigger must never turn into a
// Netlify retry of the whole webhook (see the split failure handling
// comment in the handler below).
async function triggerMasterclassConfirmation(registrationId) {
  if (!MASTERCLASS_NOTIFY_SECRET) {
    console.error('form-webhook: MASTERCLASS_NOTIFY_SECRET is not set, cannot trigger the masterclass confirmation');
    return;
  }

  try {
    const res = await fetch(MASTERCLASS_NOTIFY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MASTERCLASS_NOTIFY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ registrationId }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`form-webhook: masterclass notify returned ${res.status}: ${body}`);
      return;
    }

    console.log(`form-webhook: triggered the masterclass confirmation for registration ${registrationId}`);
  } catch (err) {
    console.error('form-webhook: masterclass notify call failed:', err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('form-webhook: failed to parse request body as JSON', err);
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const { formName, data } = extractSubmission(body);

  if (!formName) {
    console.error('form-webhook: submission payload missing form_name', body);
    return { statusCode: 400, body: 'Missing form_name in payload' };
  }

  const handlerConfig = FORM_HANDLERS[formName];
  if (!handlerConfig) {
    // Not one of the forms we're wired for -- acknowledge so Netlify
    // doesn't retry, but log it in case a new form needs to be added here.
    console.warn(`form-webhook: no handler configured for form "${formName}", ignoring`);
    return { statusCode: 202, body: `No handler for form "${formName}"` };
  }

  const row = handlerConfig.map(data);
  const missing = handlerConfig.required.filter((field) => row[field] === null);
  if (missing.length) {
    console.error(
      `form-webhook: submission for "${formName}" missing required field(s): ${missing.join(', ')}`,
      { data }
    );
    return { statusCode: 400, body: `Missing required field(s): ${missing.join(', ')}` };
  }

  let client;
  try {
    client = getSupabaseClient();
  } catch (err) {
    console.error('form-webhook: Supabase client init failed:', err.message);
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  let inserted;

  if (handlerConfig.upsertKey) {
    // PROMPT_63. pt-masterclass only, for now: an update on a repeat
    // registration rather than the insert-or-ignore every other handler
    // uses. See upsertByLowerEmail's own doc comment for why this needs
    // its own two step path instead of Supabase's .upsert({ onConflict }).
    try {
      const result = await upsertByLowerEmail(client, handlerConfig.table, handlerConfig.upsertKey, row);
      inserted = { id: result.id };
      console.log(
        `form-webhook: ${result.action} "${formName}" submission in "${handlerConfig.table}" (id ${result.id})`
      );
    } catch (err) {
      console.error(
        `form-webhook: Supabase upsert into "${handlerConfig.table}" failed for form "${formName}":`,
        err
      );
      Sentry.captureException(new Error(`Supabase upsert into "${handlerConfig.table}" failed: ${err.message}`), {
        extra: { formName, table: handlerConfig.table, code: err.code },
      });
      await Sentry.flush(2000);
      // 500 so Netlify retries. Nothing was durably lost: a registration
      // that failed to land here never claimed a row, so a retry is
      // exactly as safe as the plain insert path's own retry below.
      return { statusCode: 500, body: `Failed to save submission: ${err.message}` };
    }
  } else {
    // .select('id').single() so the new row's id is available to trigger
    // email 1. Without it there is nothing to hand the portal.
    const { data: insertedRow, error } = await client
      .from(handlerConfig.table)
      .insert(row)
      .select('id')
      .single();

    // ALREADY ON THE LIST IS NOT AN ERROR. waitlist_signups carries a
    // unique index on lower(email) as of 25 September, because the score
    // results page became a second entry point and the same person can
    // now reach the list twice. Returning 500 here would make Netlify
    // retry forever, and the person would either get a second welcome
    // email or none at all. 200, no insert, no welcome: they already had
    // one the first time.
    if (error && error.code === '23505') {
      console.log(
        `form-webhook: "${formName}" submission is already on the list, nothing to do`
      );
      return { statusCode: 200, body: 'Already subscribed' };
    }

    if (error) {
      console.error(
        `form-webhook: Supabase insert into "${handlerConfig.table}" failed for form "${formName}":`,
        error
      );
      // PROMPT_60. For the consent carrying form this is also, specifically,
      // a consent write failing -- the whole row, marketing fields included,
      // never reaches the table. Visible beyond Netlify's own function log.
      Sentry.captureException(new Error(`Supabase insert into "${handlerConfig.table}" failed: ${error.message}`), {
        extra: { formName, table: handlerConfig.table, code: error.code },
      });
      await Sentry.flush(2000);
      // 500 so Netlify retries. Nothing was written, so a retry is safe and
      // is the only way the submission is not simply lost.
      return { statusCode: 500, body: `Failed to save submission: ${error.message}` };
    }

    inserted = insertedRow;
    console.log(`form-webhook: inserted "${formName}" submission into "${handlerConfig.table}"`);
  }

  // SPLIT FAILURE HANDLING, and the ordering matters. The insert has
  // already succeeded by this point, so a failure in the notify call must
  // NOT return a non-2xx: Netlify would retry the whole webhook and insert
  // the submission a second time, turning a missing email into a duplicate
  // row. The portal's daily cron independently picks up any submission
  // older than ten minutes with no email 1 recorded, so a lost trigger
  // self-heals within a day and a duplicate row would not.
  if (formName === 'mental-fitness-score' && inserted && inserted.id) {
    await triggerResultEmail(inserted.id);
  }

  // Same split failure handling as above. The portal's daily cron carries
  // a safety net for any signup older than ten minutes with no welcome
  // recorded, so a lost trigger self heals within a day. A duplicate row
  // would not, which is why this must never return a non-2xx.
  if (formName === 'waitlist' && inserted && inserted.id) {
    await triggerWaitlistWelcome(inserted.id);
  }

  // Same split failure handling again, and fires on BOTH outcomes of
  // the upsert above (an insert or an update), not only an insert --
  // someone re registering for a later session date is owed a new
  // confirmation too, and it is the portal's own ledger (keyed on
  // registration id, email key AND session date, not just the row's
  // existence) that actually decides whether this particular call has
  // anything new to send. The portal's hourly cron no longer touches
  // this key at all, so this is now the one and only path a masterclass
  // confirmation can go out through -- a lost trigger here has no daily
  // safety net the way email 1 above does, which is exactly why
  // PROMPT_64 asked for it to fire inline rather than only from a cron.
  if (formName === 'pt-masterclass' && inserted && inserted.id) {
    await triggerMasterclassConfirmation(inserted.id);
  }

  // Covers the consent mismatch event queued inside the mental-fitness-score
  // map() above, on the success path where the row still inserted (minus
  // consent). A short lived function will not deliver a queued event on
  // its own once this returns, so every success exit flushes once here.
  await Sentry.flush(2000);

  return { statusCode: 200, body: 'OK' };
};
