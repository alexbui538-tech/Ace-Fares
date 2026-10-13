// Runs every 15 minutes:
//  - security deposit holds: places them ~24h before pickup, renews holds that would expire
//    mid-rental, and releases them 72h after return (lib/deposits.mjs)
//  - referrals: gives $100 credit when an invited friend's 3+ day trip has ended (lib/referrals.mjs)
//  - reviews: emails each renter a review link a couple of hours after their trip ends (lib/reviews.mjs)
//  - reminders: pickup (24h before) and return-day emails to renters; vehicle service due dates to the owner
//  - ID checks: has Stripe delete license images and face data once they're no longer needed (lib/identity.mjs)
import { makeDeposits } from "../../lib/deposits.mjs";
import { makeIdentity } from "../../lib/identity.mjs";
import * as d from "../../lib/deps.mjs";

export default async () => {
  await d.ready();
  const notify = await d.ownerNotifier();
  const done = await makeDeposits({ store: d.store(), stripe: d.stripe(), now: d.now, notify }).sweep();
  const redacted = await makeIdentity({ store: d.store(), stripe: d.stripe(), now: d.now, notify, mailer: await d.mailer(), siteUrl: d.siteUrl() }).sweep();
  const rewards = await (await d.referrals()).sweep();
  const asked = await (await d.reviews()).sweep();
  const { makeReminders } = await import("../../lib/reminders.mjs");
  const { makeAdminTools } = await import("../../lib/admin-tools.mjs");
  const reminded = await makeReminders({ store: d.store(), mailer: await d.mailer(), siteUrl: d.siteUrl(), now: d.now }).sweep();
  const vehicles = await makeAdminTools({ store: d.store(), now: d.now, notify }).sweep();
  const all = { deposits: done, idChecks: redacted, referralRewards: rewards, reviewRequests: asked, reminders: reminded, vehicles };
  if (Object.values(all).some(x => x.length)) console.log("[every 15 min]", JSON.stringify(all));
};
export const config = { schedule: "*/15 * * * *" };   // every 15 minutes (the ID check is due within an hour of booking)
