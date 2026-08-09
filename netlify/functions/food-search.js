// netlify/functions/food-search.js
//
// GET /.netlify/functions/food-search?q=chicken%20breast%20cooked
//
// Server-side proxy that searches multiple free/open nutrition sources in
// parallel and returns a merged, normalized result set. The browser never
// sees the USDA API key -- it's read from process.env.USDA_API_KEY here.
// Open Food Facts needs no key at all.
//
// Sources, in priority order (per the project's nutrition data
// architecture -- USDA primary, Open Food Facts secondary):
//   1. USDA FoodData Central  -- generic/whole foods, US-centric
//   2. Open Food Facts        -- packaged/branded products, barcode data,
//                                notably better AU/international brand
//                                coverage than USDA
//
// Required environment variable (set in Netlify: Site configuration ->
// Environment variables):
//   USDA_API_KEY   your USDA FoodData Central API key (never commit this,
//                   never log it, never echo it back in a response)
// Open Food Facts requires no signup or key.
//
// DESIGN NOTES / WHY IT'S BUILT THIS WAY:
//
// - Both sources are queried with Promise.allSettled, not sequentially --
//   if one is slow or down, it doesn't hold up the other, and a total
//   failure on one source still returns results from the other rather
//   than a blanket 500. Each source's ok/error state is included in the
//   response's `sources` field for debugging (check Netlify function logs
//   for the same information server-side).
// - Each fetch has an explicit timeout via AbortController. Netlify
//   Functions have their own execution time limit; without this, one
//   hanging upstream request could eat the whole budget and take the
//   other source down with it.
// - Open Food Facts sends a descriptive User-Agent, per their API usage
//   policy (https://openfoodfacts.github.io/api-documentation/) -- a
//   generic/missing User-Agent risks being rate-limited or blocked.
// - Open Food Facts data is ODbL-licensed (Open Database License), which
//   requires attribution when the data is displayed publicly. The
//   `source` field on every normalized result exists so the UI can credit
//   the right source per item; nutrition.html also carries a persistent
//   attribution line. USDA data is US public domain (no attribution
//   legally required, credited anyway as good practice).
// - Both USDA and Open Food Facts report an "Energy" nutrient in BOTH
//   kcal and kJ under near-identical field names. Getting this wrong
//   silently returns a calorie value ~4.18x too high -- this exact bug
//   was caught live for USDA (see NUTRIENT_MATCHERS below) and the same
//   care applies to Open Food Facts, where the kcal figure is read from
//   the explicitly-suffixed `energy-kcal_100g` field rather than the
//   ambiguous `energy_100g` (which is kJ).

const USDA_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const OFF_SEARCH_URL = 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_USER_AGENT = 'CenturioNutritionTool/1.0 (https://centuriocollective.com)';
const PAGE_SIZE_PER_SOURCE = 8;
// NOT larger. Two separate live attempts to widen OFF's result pool for
// better AU sorting -- first via a second parallel country-filtered
// request, then via page_size=24 on the single request -- both caused
// live 503s from OFF's legacy cgi/search.pl endpoint. page_size=8 with no
// extra params is the one request shape confirmed reliable twice in
// production; do not change this without a live-verified reason. AU
// products are sorted to the front of whatever this returns (see
// searchOpenFoodFacts), but only within this page size -- if better AU
// coverage is needed beyond what a soft sort of 8 results can deliver,
// the fix is a separate AU-specific data source (see README), not
// pushing this endpoint further.
const OFF_CANDIDATE_POOL_SIZE = PAGE_SIZE_PER_SOURCE;
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// USDA FoodData Central
// ---------------------------------------------------------------------

// USDA nutrient IDs are more stable than nutrientName strings across data
// types, so match on nutrientId first and fall back to a name match.
//
// IMPORTANT: USDA records commonly carry TWO "Energy" entries -- one in
// kcal (nutrientId 1008) and one in kJ (nutrientId 1062), both with
// nutrientName "Energy". Matching by id-or-name in a single pass can grab
// the kJ entry ahead of the kcal one depending on array order, silently
// returning a value ~4.18x too high. `unit` pins the fallback to the
// entry with the expected unit so that can't happen even when a record
// lacks nutrientId and we have to fall back to name matching.
const USDA_NUTRIENT_MATCHERS = {
  calories: { id: 1008, names: ['energy'], unit: 'KCAL' },
  protein: { id: 1003, names: ['protein'], unit: 'G' },
  fat: { id: 1004, names: ['total lipid (fat)', 'total fat'], unit: 'G' },
  carbs: { id: 1005, names: ['carbohydrate, by difference', 'carbohydrate'], unit: 'G' },
  fibre: { id: 1079, names: ['fiber, total dietary', 'fiber'], unit: 'G' },
};

function findUsdaNutrientValue(foodNutrients, matcher) {
  if (!Array.isArray(foodNutrients)) return null;

  // /foods/search returns a flat shape ({ nutrientId, nutrientName, value, unitName }).
  // Handle a nested { nutrient: { id, name, unitName }, amount } shape defensively too,
  // in case USDA changes the response or a detail-endpoint call is added later.
  const idOf = (n) => n.nutrientId ?? n.nutrient?.id;
  const nameOf = (n) => (n.nutrientName ?? n.nutrient?.name ?? '').toLowerCase();
  const unitOf = (n) => (n.unitName ?? n.nutrient?.unitName ?? '').toUpperCase();
  const valueOf = (n) => {
    const v = n.value ?? n.amount;
    return typeof v === 'number' ? v : null;
  };

  // Pass 1: an exact nutrient ID match is authoritative -- check the whole
  // array first so a same-named-but-wrong-unit entry earlier in the array
  // (e.g. kJ Energy before kcal Energy) can never win over it.
  const byId = foodNutrients.find((n) => idOf(n) === matcher.id);
  if (byId) return valueOf(byId);

  // Pass 2: no ID match found (some records omit nutrientId) -- fall back
  // to name, preferring whichever candidate has the expected unit.
  const byName = foodNutrients.filter((n) => matcher.names.includes(nameOf(n)));
  if (!byName.length) return null;
  const preferred = matcher.unit ? byName.find((n) => unitOf(n) === matcher.unit) : null;
  return valueOf(preferred || byName[0]);
}

function normalizeUsdaFood(food) {
  const foodNutrients = food.foodNutrients || [];
  return {
    source: 'usda',
    fdcId: food.fdcId ?? null,
    code: null,
    description: food.description ?? null,
    brandName: food.brandName ?? food.brandOwner ?? null,
    dataType: food.dataType ?? null,
    servingSize: typeof food.servingSize === 'number' ? food.servingSize : null,
    servingSizeUnit: food.servingSizeUnit ?? null,
    calories: findUsdaNutrientValue(foodNutrients, USDA_NUTRIENT_MATCHERS.calories),
    protein: findUsdaNutrientValue(foodNutrients, USDA_NUTRIENT_MATCHERS.protein),
    carbs: findUsdaNutrientValue(foodNutrients, USDA_NUTRIENT_MATCHERS.carbs),
    fat: findUsdaNutrientValue(foodNutrients, USDA_NUTRIENT_MATCHERS.fat),
    fibre: findUsdaNutrientValue(foodNutrients, USDA_NUTRIENT_MATCHERS.fibre),
  };
}

async function searchUsda(query) {
  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) {
    console.warn('food-search: USDA_API_KEY is not set -- skipping USDA source for this search');
    return { ok: false, error: 'USDA not configured', results: [] };
  }

  const url = new URL(USDA_SEARCH_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', String(PAGE_SIZE_PER_SOURCE));

  let res;
  try {
    res = await fetchWithTimeout(url.toString());
  } catch (err) {
    console.error('food-search: USDA request failed or timed out:', err.message);
    return { ok: false, error: 'USDA request failed', results: [] };
  }

  if (!res.ok) {
    // Never forward the raw USDA error body -- it can echo query params
    // back, and there's no reason to expose upstream response internals.
    console.error(`food-search: USDA responded ${res.status} for query "${query}"`);
    return { ok: false, error: res.status === 429 ? 'USDA rate limit exceeded' : `USDA error ${res.status}`, results: [] };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('food-search: failed to parse USDA response as JSON:', err.message);
    return { ok: false, error: 'Invalid USDA response', results: [] };
  }

  const results = Array.isArray(data.foods) ? data.foods.map(normalizeUsdaFood) : [];
  return { ok: true, results };
}

// ---------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------

// Open Food Facts numbers come from crowdsourced label entry, not a
// curated dataset like USDA's -- they arrive with noise like
// 103.967495219885 (likely back-computed from a per-serving value). Round
// to sensible display/edit precision rather than passing raw floats
// through to an editable input field.
function roundOffValue(v, decimals) {
  if (typeof v !== 'number') return null;
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}

function normalizeOffProduct(product) {
  const n = product.nutriments || {};
  const pick = (key, decimals) => (typeof n[key] === 'number' ? roundOffValue(n[key], decimals) : null);
  const countriesTags = Array.isArray(product.countries_tags) ? product.countries_tags : [];
  return {
    source: 'openfoodfacts',
    fdcId: null,
    code: product.code || null,
    description: product.product_name || null,
    brandName: product.brands || null,
    dataType: 'Open Food Facts',
    servingSize: null, // OFF's `quantity` is freeform label text (e.g. "500 g bottle"),
    servingSizeUnit: null, // not a reliable structured number -- leave unset rather than guess.
    // Explicitly the KCAL-suffixed field. OFF also has `energy_100g`, which
    // is kJ -- reading that instead would silently repeat the exact
    // kJ/kcal bug already found and fixed on the USDA side.
    calories: pick('energy-kcal_100g', 0),
    protein: pick('proteins_100g', 1),
    carbs: pick('carbohydrates_100g', 1),
    fat: pick('fat_100g', 1),
    fibre: pick('fiber_100g', 1),
    // Internal only, stripped before the response goes out -- used to sort
    // AU-tagged products first. Not part of the public result shape.
    _isAu: countriesTags.includes('en:australia'),
  };
}

// A SINGLE unfiltered query -- deliberately not a second country-filtered
// request. An earlier version of this function issued two parallel
// requests to OFF's cgi/search.pl (one filtered by countries_tags, one
// not) to bias toward Australian products, and that doubled load on OFF's
// older/less reliable legacy search endpoint, which then started
// returning 503s in production. Requesting `countries_tags` as an extra
// field on the one query that was already working reliably gets the same
// "AU products first" outcome via a local sort, with no extra requests.
async function searchOpenFoodFacts(query) {
  const url = new URL(OFF_SEARCH_URL);
  url.searchParams.set('search_terms', query);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', String(OFF_CANDIDATE_POOL_SIZE));
  url.searchParams.set('fields', 'code,product_name,brands,nutriments,countries_tags');

  let res;
  try {
    res = await fetchWithTimeout(url.toString(), { headers: { 'User-Agent': OFF_USER_AGENT } });
  } catch (err) {
    console.error('food-search: Open Food Facts request failed or timed out:', err.message);
    return { ok: false, error: 'Open Food Facts request failed', results: [] };
  }

  if (!res.ok) {
    console.error(`food-search: Open Food Facts responded ${res.status} for query "${query}"`);
    return { ok: false, error: `Open Food Facts error ${res.status}`, results: [] };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('food-search: failed to parse Open Food Facts response as JSON:', err.message);
    return { ok: false, error: 'Invalid Open Food Facts response', results: [] };
  }

  const products = Array.isArray(data.products) ? data.products.map(normalizeOffProduct) : [];

  // Stable sort (guaranteed by the spec since ES2019 / Node 12+): AU-tagged
  // products move to the front, everything else keeps its original
  // relevance order from OFF. Soft priority, not a filter -- nothing is
  // dropped just for lacking a country tag, since tagging is inconsistent.
  // Sorted across the full OFF_CANDIDATE_POOL_SIZE pool (not just the
  // final display count) so an AU product ranked outside OFF's own top
  // PAGE_SIZE_PER_SOURCE still gets a chance to surface.
  products.sort((a, b) => (b._isAu ? 1 : 0) - (a._isAu ? 1 : 0));
  const results = products.slice(0, PAGE_SIZE_PER_SOURCE).map(({ _isAu, ...rest }) => rest);

  return { ok: true, results };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const q = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
  if (!q) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required query parameter "q"' }) };
  }

  const [usdaOutcome, offOutcome] = await Promise.allSettled([searchUsda(q), searchOpenFoodFacts(q)]);

  // Promise.allSettled means neither branch throws past this point even if
  // a source's promise rejected outright (vs. resolving with ok:false) --
  // normalize both shapes so one source's unexpected crash can't 500 the
  // whole search when the other source is fine.
  const usda = usdaOutcome.status === 'fulfilled'
    ? usdaOutcome.value
    : { ok: false, error: usdaOutcome.reason && usdaOutcome.reason.message || 'USDA search failed unexpectedly', results: [] };
  const off = offOutcome.status === 'fulfilled'
    ? offOutcome.value
    : { ok: false, error: offOutcome.reason && offOutcome.reason.message || 'Open Food Facts search failed unexpectedly', results: [] };

  const results = [...usda.results, ...off.results];

  console.log(
    `food-search: query "${q}" -> USDA: ${usda.ok ? usda.results.length + ' result(s)' : 'failed (' + usda.error + ')'}, ` +
    `Open Food Facts: ${off.ok ? off.results.length + ' result(s)' : 'failed (' + off.error + ')'}`
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: q,
      results,
      sources: {
        usda: { ok: usda.ok, count: usda.results.length, error: usda.ok ? undefined : usda.error },
        openFoodFacts: { ok: off.ok, count: off.results.length, error: off.ok ? undefined : off.error },
      },
    }),
  };
};
