import { agreementPageHandler } from "../../lib/handlers.mjs";
import * as d from "../../lib/deps.mjs";

const page = agreementPageHandler();
export default async (req) => { await d.ready(); return page(req); };
export const config = { path: "/rental-agreement" };
