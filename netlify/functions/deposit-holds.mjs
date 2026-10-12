// Runs every hour:
//  - security deposit holds: places them ~24h before pickup, renews holds that would expire
//    mid-rental, and releases them 72h after return (lib/deposits.mjs)
//  - referrals: gives $100 credit when an invited friend's 4+ day trip has ended (lib/referrals.mjs)
//  - ID checks: has Stripe delete license images and face data once they're no longer needed (lib/identity.mjs)
import { makeDeposits } from "../../lib/deposits.mjs";
import { makeIdentity } from "../../lib/identity.mjs";
import * as d from "../../lib/deps.mjs";

export default async () => {
  const notify = await d.ownerNotifier();
  const done = await makeDeposits({ store: d.store(), stripe: d.stripe(), now: d.now, notify }).sweep();
  const redacted = await makeIdentity({ store: d.store(), stripe: d.stripe(), now: d.now, notify }).sweep();
  const rewards = await (await d.referrals()).sweep();
  if (done.length || redacted.length || rewards.length) console.log("[hourly] deposits:", JSON.stringify(done), "id checks:", JSON.stringify(redacted), "referral rewards:", JSON.stringify(rewards));
};
export const config = { schedule: "@hourly" };
