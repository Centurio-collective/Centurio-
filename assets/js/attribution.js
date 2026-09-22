/* ------------------------------------------------------------------
   Centurio attribution capture, shared across pages.

   Lifted verbatim from the inline copy in score.html so the two cannot
   drift. That copy only ran on score.html, which meant an ad click
   landing on the homepage or /1on1 lost its parameters entirely: by the
   time the visitor reached score.html, landing_url read as score.html
   and the utm values from the original click were gone.

   Loading this on every entry page fixes that. State lives in
   sessionStorage under one key, so whichever page the session starts on
   is the one recorded, and score.html's own module reads the same key
   and correctly declines to overwrite it.

   KNOWN LIMIT, unchanged: a visitor who clicks an ad, closes the tab and
   returns later in a new session arrives with null attribution even
   though an ad produced them. Someone who sees an ad, does not click and
   arrives by search is the same. No client side mechanism recovers
   either, so ad-driven signups counted here will read lower than the ad
   platform claims. Expect that gap and measure it rather than treating
   it as a bug.
   ------------------------------------------------------------------ */

var ATTRIBUTION_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid', 'referrer', 'landing_url'
];

/* The parameters a click carries. Separate from the two entry point
   fields below because they follow a different persistence rule. */
var ATTRIBUTION_CLICK_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid'
];

var ATTRIBUTION_KEY = 'centurio_attribution';

/* A referrer or landing url can be arbitrarily long. Capped so a
   pathological one cannot bloat the submission or the row. */
var ATTRIBUTION_MAX = 500;

function attributionRead() {
  try {
    var raw = sessionStorage.getItem(ATTRIBUTION_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    /* Private mode, disabled storage, corrupt value. Attribution is
       never worth failing a submission over. */
    return {};
  }
}

function attributionWrite(value) {
  try {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(value));
  } catch (err) {
    /* See above. */
  }
}

function attributionClip(value) {
  return String(value == null ? '' : value).slice(0, ATTRIBUTION_MAX);
}

(function attributionCapture() {
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (err) {
    return;
  }

  var stored = attributionRead();

  /* ENTRY POINT: written once, on the first pageview of the session,
     and never overwritten. This is where the visit began, tagged or
     not, which stays true even if a tagged click arrives later. */
  if (!stored.landing_url) {
    stored.landing_url = attributionClip(window.location.href);
    stored.referrer = attributionClip(document.referrer);
  }

  /* CLICK PARAMETERS: written on the first pageview that actually
     carries one, and never overwritten after that.

     Not simply "first touch wins". Applied literally that rule stores
     an empty bundle on an untagged first pageview and then locks out a
     genuine ad click later in the same session, which is the common
     case for anyone who browses the site before clicking an ad. */
  var carriesClick = ATTRIBUTION_CLICK_FIELDS.some(function (field) {
    return params.get(field);
  });
  var alreadyStored = ATTRIBUTION_CLICK_FIELDS.some(function (field) {
    return stored[field];
  });

  if (carriesClick && !alreadyStored) {
    ATTRIBUTION_CLICK_FIELDS.forEach(function (field) {
      stored[field] = attributionClip(params.get(field));
    });
  }

  attributionWrite(stored);
})();

/* Every field, always present, empty string when absent. A fixed shape
   means the submission body never varies, so a missing value can never
   be confused with a missing field. */
function attributionValues() {
  var stored = attributionRead();
  var out = {};
  ATTRIBUTION_FIELDS.forEach(function (field) {
    out[field] = stored[field] || '';
  });
  return out;
}

/* Populates the hidden inputs on any form that carries them. Fields are
   id="hidden_" + field name, matching score.html, so the markup and this
   loop are driven from one array and cannot fall out of step.

   Called on DOMContentLoaded and again on submit. The second call is
   belt and braces: sessionStorage is already written by the capture IIFE
   above, which runs on script load, but a form injected later would
   otherwise submit empty. */
function attributionFillForm(form) {
  if (!form) return;
  var values = attributionValues();
  ATTRIBUTION_FIELDS.forEach(function (field) {
    var el = form.querySelector('[name="' + field + '"]');
    if (el) el.value = values[field];
  });
}

function attributionBindForms(selector) {
  var forms = document.querySelectorAll(selector);
  Array.prototype.forEach.call(forms, function (form) {
    attributionFillForm(form);
    form.addEventListener('submit', function () { attributionFillForm(form); });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  attributionBindForms('form[data-attribution]');
});
