import { webhookHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => webhookHandler({ store: d.store(), stripe: d.stripe(), webhookSecret: d.env("STRIPE_WEBHOOK_SECRET"), now: d.now, mailer: await d.mailer(), siteUrl: d.siteUrl(), notify: await d.ownerNotifier() })(req);
export const config = { path: "/api/stripe-webhook" };
