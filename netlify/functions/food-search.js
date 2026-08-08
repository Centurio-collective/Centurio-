// netlify/functions/food-search.js
//
// GET /.netlify/functions/food-search?q=chicken%20breast%20cooked
//
// Server-side proxy to USDA FoodData Central's food search endpoint. The
// browser never sees the USDA API key -- this function reads it from
// process.env.USDA_API_KEY and returns a normalized, minimal result set.
//
// Required environment variable (set in Netlify: Site configuration ->
// Environment variables):
//   USDA_API_KEY   your USDA FoodData Central API key (never commit this,
//                   never log it, never echo it back in a response)
//
// NOTE ON NUTRIENT BASIS: USDA's /foods/search endpoint reports
// foodNutrients values per 100g of the food for Foundation, SR Legacy and
// most Branded records. This function trusts that convention and returns
// nutrientsPer100g accordingly. Per the project handover doc's caveat,
// this has NOT been verified against a live response in this environment
// (this sandbox cannot reach api.nal.usda.gov) -- test with a real query
// after deploy and spot-check a couple of dataTypes (esp. "Branded")
// before relying on it for anything beyond an estimate. If a food's
// nutrients turn out to be serving-based rather than per-100g, this
// function has no way to detect that from the search response alone; the
// "Preferred robust direction" in the handover (a second per-fdcId detail
// call) is the fix if that turns out to matter.

const USDA_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const PAGE_SIZE = 12;

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
const NUTRIENT_MATCHERS = {
  calories: { id: 1008, names: ['energy'], unit: 'KCAL' },
  protein: { id: 1003, names: ['protein'], unit: 'G' },
  fat: { id: 1004, names: ['total lipid (fat)', 'total fat'], unit: 'G' },
  carbs: { id: 1005, names: ['carbohydrate, by difference', 'carbohydrate'], unit: 'G' },
  fibre: { id: 1079, names: ['fiber, total dietary', 'fiber'], unit: 'G' },
};

function findNutrientValue(foodNutrients, matcher) {
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

function normalizeFood(food) {
  const foodNutrients = food.foodNutrients || [];
  return {
    fdcId: food.fdcId ?? null,
    description: food.description ?? null,
    brandName: food.brandName ?? food.brandOwner ?? null,
    dataType: food.dataType ?? null,
    servingSize: typeof food.servingSize === 'number' ? food.servingSize : null,
    servingSizeUnit: food.servingSizeUnit ?? null,
    calories: findNutrientValue(foodNutrients, NUTRIENT_MATCHERS.calories),
    protein: findNutrientValue(foodNutrients, NUTRIENT_MATCHERS.protein),
    carbs: findNutrientValue(foodNutrients, NUTRIENT_MATCHERS.carbs),
    fat: findNutrientValue(foodNutrients, NUTRIENT_MATCHERS.fat),
    fibre: findNutrientValue(foodNutrients, NUTRIENT_MATCHERS.fibre),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const q = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
  if (!q) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required query parameter "q"' }) };
  }

  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) {
    console.error('food-search: USDA_API_KEY environment variable is not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  const url = new URL(USDA_SEARCH_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', q);
  url.searchParams.set('pageSize', String(PAGE_SIZE));

  let usdaResponse;
  try {
    usdaResponse = await fetch(url.toString());
  } catch (err) {
    console.error('food-search: network error calling USDA API:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach USDA FoodData Central' }) };
  }

  if (!usdaResponse.ok) {
    // Never forward the raw USDA error body -- it can echo query params
    // back, and there's no reason to expose upstream response internals.
    console.error(`food-search: USDA API returned ${usdaResponse.status} for query "${q}"`);
    const status = usdaResponse.status === 429 ? 429 : 502;
    return {
      statusCode: status,
      body: JSON.stringify({ error: status === 429 ? 'USDA API rate limit exceeded, try again shortly' : 'USDA API error' }),
    };
  }

  let data;
  try {
    data = await usdaResponse.json();
  } catch (err) {
    console.error('food-search: failed to parse USDA response as JSON:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Invalid response from USDA FoodData Central' }) };
  }

  const foods = Array.isArray(data.foods) ? data.foods.map(normalizeFood) : [];

  console.log(`food-search: query "${q}" returned ${foods.length} normalized result(s)`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, results: foods }),
  };
};
