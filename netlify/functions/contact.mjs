import { contactHandler } from "../../lib/host.mjs";
import * as d from "../../lib/deps.mjs";

// "Send us a message" form -> business inbox (lib/host.mjs)
export default async (req, context) => contactHandler({ store: d.store(), mailer: await d.mailer(), now: d.now })(req, context);
export const config = { path: "/api/contact" };
