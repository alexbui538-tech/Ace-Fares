import { adminResetHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => adminResetHandler({ store: d.store(), stripe: d.stripe(), adminKey: process.env.ADMIN_KEY, now: d.now })(req);
export const config = { path: "/api/admin/reset" };
