import { payHandler } from "../../lib/pay.mjs";
import * as d from "../../lib/deps.mjs";

// Payment links for post-trip charges (lib/pay.mjs)
export default async (req) => payHandler({ store: d.store(), stripe: d.stripe(), siteUrl: d.siteUrl(), now: d.now, notify: await d.ownerNotifier() })(req);
export const config = { path: "/api/pay" };
