import Stripe from "stripe";

/**
 * Server-only Stripe client. Do not import from Client Components.
 *
 * Points at test-mode keys during development; switch to live keys in
 * the Netlify site's env vars only once webhook handling has been
 * verified end-to-end (see FD-038 -- membership products, real
 * customers, and the EMF10 discount code live on the same Stripe
 * account we'll cut over to).
 */
export function createStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set.");
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
  });
}
