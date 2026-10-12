import { bookingStatusHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => bookingStatusHandler({ store: d.store(), stripe: d.stripe(), now: d.now, mailer: await d.mailer(), siteUrl: d.siteUrl(), notify: await d.ownerNotifier(), referrals: await d.referrals(), accounts: await d.auth() })(req);
export const config = { path: "/api/booking" };
