import { cancelHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => cancelHandler({ store: d.store(), stripe: d.stripe(), now: d.now })(req);
export const config = { path: "/api/cancel" };
