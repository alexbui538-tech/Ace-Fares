// Runs every 15 minutes:
//  - security deposit holds: places them ~24h before pickup, renews holds that would expire
//    mid-rental, and releases them 72h after return (lib/deposits.mjs)
//  - referrals: gives $100 credit when an invited friend's 3+ day trip has ended (lib/referrals.mjs)
//  - reviews: emails each renter a review link a couple of hours after their trip ends (lib/reviews.mjs)
//  - ID checks: has Stripe delete license images and face data once they're no longer needed (lib/identity.mjs)
import { makeDeposits } from "../../lib/deposits.mjs";
import { makeIdentity } from "../../lib/identity.mjs";
import * as d from "../../lib/deps.mjs";

export default async () => {
  const notify = await d.ownerNotifier();
  const done = await makeDeposits({ store: d.store(), stripe: d.stripe(), now: d.now, notify }).sweep();
  const redacted = await makeIdentity({ store: d.store(), stripe: d.stripe(), now: d.now, notify, mailer: await d.mailer(), siteUrl: d.siteUrl() }).sweep();
  const rewards = await (await d.referrals()).sweep();
  const asked = await (await d.reviews()).sweep();
  if (done.length || redacted.length || rewards.length || asked.length) console.log("[hourly] deposits:", JSON.stringify(done), "id checks:", JSON.stringify(redacted), "referral rewards:", JSON.stringify(rewards), "review requests:", JSON.stringify(asked));
};
export const config = { schedule: "*/15 * * * *" };   // every 15 minutes (the ID check is due within an hour of booking)
