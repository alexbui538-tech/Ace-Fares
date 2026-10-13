import * as d from "../../lib/deps.mjs";

export default async (req) => (await d.reviews()).handler({ userOf: (await d.auth()).userOf })(req);
export const config = { path: "/api/reviews" };
