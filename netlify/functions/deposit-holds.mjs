// Runs every hour: places security deposit holds ~24h before pickup, renews holds that would
// expire mid-rental, and releases holds 72h after return. See lib/deposits.mjs.
import { makeDeposits } from "../../lib/deposits.mjs";
import * as d from "../../lib/deps.mjs";

export default async () => {
  const done = await makeDeposits({ store: d.store(), stripe: d.stripe(), now: d.now, notify: await d.ownerNotifier() }).sweep();
  if (done.length) console.log("[deposit] hourly run:", JSON.stringify(done));
};
export const config = { schedule: "@hourly" };
