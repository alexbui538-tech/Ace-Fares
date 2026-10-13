// Renter reviews.
//  - A couple of hours after each trip's scheduled return, the renter gets an email asking for a review
//    (a private link with a one-time token). They can also leave one from My trips.
//  - One review per trip, only from the renter who booked it, only once the trip has ended.
//  - Reviews show on the home page right away. The owner can hide one on the bookings page (nothing is deleted).
// Storage: "reviews" in the bookings store = { list: [{ id (booking id), car, carName, stars, text, name, at, hidden }] }
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CARS, REVIEW_REQUEST_HOURS } from "./catalog.mjs";
import { makeRepo } from "./bookings.mjs";
import { localMs } from "./deposits.mjs";
import { niceDate } from "./pricing.mjs";
import { getJSON, updateJSON } from "./kv.mjs";
import { simpleEmail } from "./trips.mjs";

const KEY = "reviews", H = 3600e3;
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); };
/** "Jordan Lee" -> "Jordan L." */
export const displayName = full => { const p = String(full || "").trim().split(/\s+/).filter(Boolean); return p.length ? p[0] + (p[1] ? ` ${p[p.length - 1][0].toUpperCase()}.` : "") : "Renter"; };
const tripEnded = (b, t) => b.status === "confirmed" && (t >= localMs(b.to, b.toTime) || !!(b.inspection && b.inspection.return));

export function makeReviews({ store, now = () => Date.now(), mailer = null, siteUrl = "", notify = null, log = console }) {
  const repo = makeRepo(store, { now });
  const all = async () => ((await getJSON(store, KEY)) || {}).list || [];

  async function summary() {
    const list = (await all()).filter(r => !r.hidden).sort((a, b) => (a.at < b.at ? 1 : -1));
    const avg = xs => xs.length ? Math.round(xs.reduce((a, r) => a + r.stars, 0) / xs.length * 10) / 10 : null;
    const byCar = {};
    for (const c of Object.keys(CARS)) { const xs = list.filter(r => r.car === c); if (xs.length) byCar[c] = { count: xs.length, average: avg(xs) }; }
    return { count: list.length, average: avg(list), byCar, reviews: list.slice(0, 24).map(({ id, ...r }) => r) };
  }

  async function submit(car, b, { stars, text }) {
    stars = Number(stars); text = String(text || "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim();
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw Object.assign(new Error("Choose 1 to 5 stars."), { code: "bad_stars", status: 400 });
    if (text.length > 1000) throw Object.assign(new Error("Keep your review under 1,000 characters."), { code: "too_long", status: 400 });
    const rec = { id: b.id, car, carName: CARS[car].name, stars, text, name: displayName((b.customer && b.customer.name) || b.accountName), at: new Date(now()).toISOString(), hidden: false };
    let dup = false;
    await updateJSON(store, KEY, cur => {
      const list = (cur && cur.list) || [];
      if (list.some(r => r.id === b.id)) { dup = true; return undefined; }
      return { list: [...list, rec] };
    });
    if (dup) throw Object.assign(new Error("You've already reviewed this trip. Thank you!"), { code: "already_reviewed", status: 409 });
    await repo.note(car, b.id, { reviewedAt: rec.at, reviewStars: stars });
    if (notify) { try { await notify(`New ${stars}-star review: ${CARS[car].name}`, `${rec.name} gave the ${CARS[car].name} ${stars} star${stars > 1 ? "s" : ""}${text ? `:\n\n"${text}"` : "."}\n\nIt's on your website now. You can hide it from your bookings page.`); } catch (e) { log.error("[reviews] owner notice", e && e.message); } }
    return rec;
  }

  async function setHidden(id, hidden) {
    let found = null;
    await updateJSON(store, KEY, cur => {
      const list = (cur && cur.list) || [], r = list.find(x => x.id === id);
      if (!r) return undefined;
      r.hidden = hidden; r.hiddenAt = hidden ? new Date(now()).toISOString() : null; found = r;
      return { list };
    });
    if (!found) throw Object.assign(new Error("Review not found."), { code: "not_found", status: 404 });
    return found;
  }

  /** Every 15 minutes: ask renters whose trip just ended for a review (once per trip). */
  async function sweep() {
    const t = now(), done = [];
    for (const car of Object.keys(CARS)) for (const b of await repo.all(car)) {
      if (b.status !== "confirmed" || b.reviewRequestedAt || b.reviewedAt) continue;
      const end = localMs(b.to, b.toTime);
      if (t < end + REVIEW_REQUEST_HOURS * H || t > end + 7 * 24 * H) continue;   // not trips that ended long ago
      const to = (b.customer && b.customer.email) || b.accountEmail;
      try {
        const token = b.reviewToken || randomBytes(18).toString("base64url");
        await repo.note(car, b.id, { reviewToken: token, reviewRequestedAt: new Date(t).toISOString() });   // first, so a slow email is never sent twice
        if (mailer && to) {
          const link = `${siteUrl}/review.html?car=${car}&ref=${b.id}&t=${token}`;
          const first = ((b.customer && b.customer.name) || b.accountName || "").split(" ")[0] || "there";
          await mailer.send({ to, subject: `How was the ${CARS[car].name}?`, ...simpleEmail("How was your trip?", [
            `Hi ${first}, thanks for renting the ${CARS[car].name} with Ace Fares (${niceDate(b.from)} to ${niceDate(b.to)}).`,
            { html: `Would you take a minute to leave a review? It helps other renters, and it helps a small Dallas business a lot.<br><br><a href="${esc(link)}" style="display:inline-block;background:#DAA336;color:#15130F;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px">Leave a review</a>`,
              text: `Would you take a minute to leave a review? It helps other renters, and it helps a small Dallas business a lot.\n\n${link}` },
          ]) });
        }
        done.push(["review-requested", car, b.id]);
      } catch (e) { log.error(`[reviews] request ${car} ${b.id}`, e && e.message); }
    }
    return done;
  }

  /** GET /api/reviews -> public reviews. GET /api/reviews?car=&ref=&t= -> the trip being reviewed.
   *  POST /api/reviews {car, ref, t, stars, text} (token from the email, or logged in as the renter) */
  function handler({ userOf = null } = {}) {
    const allowed = async (req, b, token) => {
      if (token && same(token, b.reviewToken)) return true;
      const u = userOf ? await userOf(req) : null;
      return !!(u && b.userId && u.id === b.userId);
    };
    return async (req) => {
      try {
        const url = new URL(req.url);
        if (req.method === "GET" && !url.searchParams.get("ref")) return json(await summary(), 200, { "cache-control": "public, max-age=60" });
        let body = {};
        if (req.method === "POST") {
          const o = req.headers.get("origin"); if (o && new URL(o).host !== url.host) return json({ error: "bad_origin" }, 403);
          const text = await req.text(); if (text.length > 4096) return json({ error: "too_large" }, 413);
          try { body = JSON.parse(text || "{}") || {}; } catch { return json({ error: "bad_request" }, 400); }
        } else if (req.method !== "GET") return json({ error: "method" }, 405);
        const p = req.method === "GET" ? Object.fromEntries(url.searchParams) : body;
        const car = p.car, ref = String(p.ref || "");
        const nope = json({ error: "not_found", message: "This review link isn't valid. Log in and open My trips to review your trip." }, 404);
        if (!CARS[car] || !/^[0-9a-f-]{36}$/.test(ref)) return nope;
        const b = await repo.get(car, ref);
        if (!b || !(await allowed(req, b, p.t))) return nope;
        const mine = (await all()).find(r => r.id === b.id);
        if (req.method === "GET") return json({ carName: CARS[car].name, photo: CARS[car].photo, from: b.from, to: b.to, name: displayName((b.customer && b.customer.name) || b.accountName),
          ended: tripEnded(b, now()), review: mine ? { stars: mine.stars, text: mine.text } : null });
        if (!tripEnded(b, now())) return json({ error: "not_yet", message: "You can review your trip once it's over." }, 409);
        const rec = await submit(car, b, body);
        return json({ ok: true, review: { stars: rec.stars, text: rec.text, name: rec.name } });
      } catch (e) {
        if (e && e.code && e.status) return json({ error: e.code, message: e.message }, e.status);
        log.error("[reviews] error", e);
        return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
      }
    };
  }

  return { all, summary, submit, setHidden, sweep, handler };
}
