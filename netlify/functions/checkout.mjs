import { checkoutHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => checkoutHandler({ store: d.store(), stripe: d.stripe(), siteUrl: d.siteUrl(), now: d.now, requireTerms: d.requireTerms() })(req);
export const config = { path: "/api/checkout" };
