import { webhookHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) {   // not set up yet: say so in the logs, without showing internals to the public
    console.error("[booking] STRIPE_WEBHOOK_SECRET is not set in Netlify, so Stripe's payment notifications can't be checked. Add it (Stripe > Developers > Webhooks > your endpoint > Signing secret).");
    return new Response(JSON.stringify({ error: "not_configured" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  return webhookHandler({ store: d.store(), stripe: d.stripe(), webhookSecret: secret, now: d.now, mailer: await d.mailer(), siteUrl: d.siteUrl(), notify: await d.ownerNotifier(), referrals: await d.referrals(), accounts: await d.auth() })(req);
};
export const config = { path: "/api/stripe-webhook" };
