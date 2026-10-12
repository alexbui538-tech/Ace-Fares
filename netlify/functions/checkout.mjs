import { checkoutHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req) => {
  const a = await d.auth();
  return checkoutHandler({ store: d.store(), stripe: d.stripe(), siteUrl: d.siteUrl(), now: d.now, requireTerms: d.requireTerms(), publishableKey: d.publishableKey(),
    userOf: a.userOf, requireAccount: d.requireAccount(), linkBooking: a.linkBooking })(req);
};
export const config = { path: "/api/checkout" };
