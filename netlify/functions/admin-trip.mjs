import { adminTripHandler } from "../../lib/trips.mjs";
import * as d from "../../lib/deps.mjs";

// Bookings page: approve/decline extensions, post-trip charges, extension switch, hide/show reviews
export default async (req) => adminTripHandler({ store: d.store(), stripe: d.stripe(), adminKey: process.env.ADMIN_KEY, now: d.now, mailer: await d.mailer(),
  siteUrl: d.siteUrl(), notify: await d.ownerNotifier(), referrals: await d.referrals(), reviews: await d.reviews() })(req);
export const config = { path: "/api/admin/trip" };
