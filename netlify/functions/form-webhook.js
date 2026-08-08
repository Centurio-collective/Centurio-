// netlify/functions/form-webhook.js
//
// Receives Netlify Forms "outgoing webhook" notifications and writes the
// submitted data into the matching Supabase table.
//
// Configure this as the target for TWO separate outgoing webhooks in
// Netlify (Site settings -> Forms -> Form notifications -> Outgoing
// webhook), one per form ("waitlist" and "mental-fitness-score"). Both
// point at this same function URL; the function branches on form_name.
//
// Required environment variables (set in Netlify: Site settings ->
// Environment variables):
//   SUPABASE_URL              e.g. https://zjfyikiitcweyjszuonl.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY the service_role secret key (NEVER the anon key)
//
// The service role key is required (not the anon key) because both target
// tables have Row Level Security enabled and no insert policy for
// anonymous/public callers -- only the service role bypasses RLS. This key
// must only ever live in Netlify's server-side environment variables; it is
// never sent to or used by the browser.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Map each Netlify form name to how it should be turned into a Supabase
// insert. Each entry defines the destination table and a `map` function
// that pulls the right fields off Netlify's submission `data` payload.
//
// Field names below were confirmed against the live form markup
// (index.html #signupForm/#signupForm2, score.html #gateForm):
//   waitlist:             <input name="name">, <input name="email">
//   mental-fitness-score: <input name="name">, <input name="email">,
//                          hidden inputs name="score", "lead_score",
//                          "align_score", "regulate_score",
//                          "connect_score", "grow_score", "perform_score"
// Note the waitlist form's field is "name" (mapped to the first_name
// column) and the assessment's overall score field is "score" (mapped
// to the overall_score column) -- neither form field is named the same
// as its destination column.
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
    map: (data) => ({
      name: str(data.name),
      email: str(data.email),
      overall_score: num(data.score),
      lead_score: num(data.lead_score),
      align_score: num(data.align_score),
      regulate_score: num(data.regulate_score),
      connect_score: num(data.connect_score),
      grow_score: num(data.grow_score),
      perform_score: num(data.perform_score),
    }),
    required: ['name', 'email'],
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

  const { error } = await client.from(handlerConfig.table).insert(row);

  if (error) {
    console.error(
      `form-webhook: Supabase insert into "${handlerConfig.table}" failed for form "${formName}":`,
      error
    );
    return { statusCode: 500, body: `Failed to save submission: ${error.message}` };
  }

  console.log(`form-webhook: inserted "${formName}" submission into "${handlerConfig.table}"`);
  return { statusCode: 200, body: 'OK' };
};
