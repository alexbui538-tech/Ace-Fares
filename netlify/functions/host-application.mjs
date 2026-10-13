import { hostHandler } from "../../lib/host.mjs";
import * as d from "../../lib/deps.mjs";

// "Become a host" form -> business inbox (lib/host.mjs)
export default async (req, context) => hostHandler({ store: d.store(), mailer: await d.mailer(), now: d.now })(req, context);
export const config = { path: "/api/host-application" };
