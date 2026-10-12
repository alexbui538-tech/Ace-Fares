import * as d from "../../lib/deps.mjs";

export default async (req, context) => (await d.auth()).handler(req, context);
export const config = { path: "/api/auth/*" };
