import { adminToolsHandler } from "../../lib/admin-tools.mjs";
import * as d from "../../lib/deps.mjs";

// Bookings page tools: blocked dates, prices, reports, export, vehicle records (lib/admin-tools.mjs)
export default async (req) => adminToolsHandler({ store: d.store(), adminKey: process.env.ADMIN_KEY, now: d.now, notify: await d.ownerNotifier() })(req);
export const config = { path: "/api/admin/tools" };
