import { verifyHandler } from "../../lib/identity.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req, context) => {
  await d.ready();
  const a = await d.auth();
  return verifyHandler({ store: d.store(), stripe: d.stripe(), userOf: a.userOf, publishableKey: d.publishableKey(), siteUrl: d.siteUrl(), now: d.now, notify: await d.ownerNotifier() })(req, context);
};
export const config = { path: "/api/verify" };
