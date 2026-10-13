import { adminDepositHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => (await d.ready(), adminDepositHandler({ store: d.store(), stripe: d.stripe(), adminKey: process.env.ADMIN_KEY, now: d.now, notify: await d.ownerNotifier() })(req));
export const config = { path: "/api/admin/deposit" };
