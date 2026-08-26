// netlify/functions/form-webhook.js
//
// Receives Netlify Forms "outgoing webhook" notifications and writes the
// submitted data into the matching Supabase table.
//
// Configure this as the target for the outgoing webhooks in Netlify
// (Site settings -> Forms -> Form notifications -> Outgoing webhook), one
// per form ("waitlist", "mental-fitness-score", "affiliate-application").
// All point at this same function URL; the function branches on form_name.
//
// Required environment variables (set in Netlify: Site settings ->
// Environment variables):
//   SUPABASE_URL              e.g. https://zjfyikiitcweyjszuonl.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY the service_role secret key (NEVER the anon key)
//   ASSESSMENT_NOTIFY_SECRET  shared secret, must match the portal's value
//                             exactly, or the assessment nurture sequence's
//                             first email never fires
//
// The service role key is required (not the anon key) because both target
// tables have Row Level Security enabled and no insert policy for
// anonymous/public callers -- only the service role bypasses RLS. This key
// must only ever live in Netlify's server-side environment variables; it is
// never sent to or used by the browser.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASSESSMENT_NOTIFY_SECRET = process.env.ASSESSMENT_NOTIFY_SECRET;

// The portal endpoint that sends email 1 of the assessment nurture
// sequence immediately, rather than waiting for the next daily cron pass.
// Overridable so this can be pointed at a preview deployment for testing.
const NOTIFY_URL =
  process.env.ASSESSMENT_NOTIFY_URL ||
  'https://members.centuriocollective.com/api/nurture/notify';

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
};

const FORM_HANDLERS = {
  waitlist: {
    table: 'waitlist_signups',
    map: (data) => ({
      first_name: str(data.name),
      email: str(data.email),
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
        console.error(
          `form-webhook: marketing consent ticked with unknown consent_version "${version}", recording as NO consent`
        );
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
        marketing_consent: consented,
        marketing_consent_at: consented ? new Date().toISOString() : null,
        marketing_consent_text: consented ? text : null,
      };
    },
    required: ['name', 'email'],
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
    }),
    required: ['gym_name', 'contact_name', 'email'],
  },
};

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

  // .select('id').single() so the new row's id is available to trigger
  // email 1. Without it there is nothing to hand the portal.
  const { data: inserted, error } = await client
    .from(handlerConfig.table)
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.error(
      `form-webhook: Supabase insert into "${handlerConfig.table}" failed for form "${formName}":`,
      error
    );
    // 500 so Netlify retries. Nothing was written, so a retry is safe and
    // is the only way the submission is not simply lost.
    return { statusCode: 500, body: `Failed to save submission: ${error.message}` };
  }

  console.log(`form-webhook: inserted "${formName}" submission into "${handlerConfig.table}"`);

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

  return { statusCode: 200, body: 'OK' };
};
