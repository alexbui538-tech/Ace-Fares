import { checkoutDetailsHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

// context.ip is the renter's IP address as Netlify sees it (recorded with their signature)
export default async (req, context) => checkoutDetailsHandler({ store: d.store(), stripe: d.stripe(), publishableKey: d.publishableKey(), now: d.now })(req, context);
export const config = { path: "/api/checkout-details" };
