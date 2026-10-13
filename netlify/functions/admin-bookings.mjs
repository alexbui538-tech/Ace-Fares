import { adminHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => (await d.ready(), adminHandler({ store: d.store(), adminKey: process.env.ADMIN_KEY, now: d.now })(req));
export const config = { path: "/api/admin/bookings" };
