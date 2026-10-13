import { availabilityHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => (await d.ready(), availabilityHandler({ store: d.store(), now: d.now })(req));
export const config = { path: "/api/availability" };
