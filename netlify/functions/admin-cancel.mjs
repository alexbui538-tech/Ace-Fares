import { adminCancelHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => adminCancelHandler({ store: d.store(), adminKey: process.env.ADMIN_KEY, now: d.now })(req);
export const config = { path: "/api/admin/cancel" };
