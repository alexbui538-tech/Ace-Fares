import { checkoutDetailsHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => checkoutDetailsHandler({ store: d.store(), stripe: d.stripe(), publishableKey: d.publishableKey(), now: d.now })(req);
export const config = { path: "/api/checkout-details" };
