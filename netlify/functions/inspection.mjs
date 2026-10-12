import { inspectionHandler } from "../../lib/inspections.mjs";
import * as d from "../../lib/deps.mjs";

export default async (req, context) => inspectionHandler({ photos: d.photosStore(), store: d.store(), userOf: (await d.auth()).userOf,
  adminKey: process.env.ADMIN_KEY, now: d.now, notify: await d.ownerNotifier() })(req, context);
export const config = { path: ["/api/inspection", "/api/inspection/*"] };
