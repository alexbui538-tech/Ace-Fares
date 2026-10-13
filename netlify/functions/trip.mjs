import { tripHandler } from "../../lib/trips.mjs";
import * as d from "../../lib/deps.mjs";

// My trips: cancel, or ask to extend (lib/trips.mjs)
export default async (req) => (await d.ready(), tripHandler({ store: d.store(), stripe: d.stripe(), userOf: (await d.auth()).userOf, now: d.now, mailer: await d.mailer(),
  siteUrl: d.siteUrl(), notify: await d.ownerNotifier(), referrals: await d.referrals() })(req));
export const config = { path: "/api/trip" };
