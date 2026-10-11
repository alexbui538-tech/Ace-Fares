// HTTP handlers. Each takes its dependencies so tests can run them with a fake
// Stripe and a local store. The files in netlify/functions wire in the real ones.
import { randomUUID } from "node:crypto";
import { CARS, LOCATIONS, TAX, CHECKOUT_MINUTES } from "./catalog.mjs";
import { validateRequest, quote, niceDate, BookingError } from "./pricing.mjs";
import { makeRepo } from "./bookings.mjs";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const fail = (err, log = console) => {
  if (err instanceof BookingError) return json({ error: err.code, message: err.message }, err.status);
  log.error("[booking] unexpected error", err);
  return json({ error: "server_error", message: "Something went wrong on our side. Please try again, or text us to book." }, 500);
};

async function readJSON(req, max = 4096) {
  const text = await req.text();
  if (text.length > max) throw new BookingError("bad_request", "Request too large.");
  try { return JSON.parse(text || "{}"); } catch { throw new BookingError("bad_request", "Something went wrong with that request. Please try again."); }
}

/** GET /api/availability -> { cars: { escalade: [{from,to}], ... } } (active bookings and holds) */
export function availabilityHandler({ store, now }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (req.method !== "GET") return json({ error: "method" }, 405);
    try {
      const cars = {};
      await Promise.all(Object.keys(CARS).map(async c => { cars[c] = (await repo.active(c)).map(b => ({ from: b.from, to: b.to })); }));
      return json({ cars });
    } catch (e) { return fail(e); }
  };
}

/** POST /api/checkout {car, from, to, fromTime, toTime, location} -> { url } */
export function checkoutHandler({ store, stripe, siteUrl, now = () => Date.now(), id = randomUUID }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    let held = null, r = null;
    try {
      r = validateRequest(await readJSON(req), new Date(now()));
      const q = quote(r);
      held = await repo.hold(r.car, r, id());
      const car = CARS[r.car], loc = LOCATIONS[r.location];
      const dates = `${niceDate(r.from)} to ${niceDate(r.to)}`;
      const meta = { booking_id: held.id, car: r.car, from: r.from, to: r.to, from_time: r.fromTime, to_time: r.toTime, location: r.location };
      const line = (name, cents, description) => ({ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name, ...(description ? { description } : {}) } } });
      const items = [line(`${car.name} rental`, q.rental - q.discount,
        `${dates} (${q.days} day${q.days > 1 ? "s" : ""}: ${[q.weekdays ? `${q.weekdays} Mon-Thu at $${q.weekdayRate}` : "", q.weekends ? `${q.weekends} Fri-Sun at $${q.weekendRate}` : ""].filter(Boolean).join(", ")}), ${car.miles * q.days} miles included${q.discount ? `. ${q.discountLabel} applied` : ""}`)];
      if (q.fee) items.push(line(loc.name, q.fee));
      items.push(line(`${TAX.label} (${q.taxPct}%)`, q.tax));
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        // payment methods come from the Stripe Dashboard settings (cards, Apple Pay, Google Pay, etc.)
        line_items: items,
        billing_address_collection: "required",
        phone_number_collection: { enabled: true },
        metadata: meta,
        payment_intent_data: { metadata: meta, description: `${car.name}, ${dates}, ${loc.name}` },
        expires_at: Math.floor(now() / 1000) + CHECKOUT_MINUTES * 60,
        success_url: `${siteUrl}/?booking=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/?booking=cancelled&car=${r.car}&ref=${held.id}`,
      }, { idempotencyKey: `checkout-${held.id}` });
      await repo.attachSession(r.car, held.id, session.id, q.total);
      return json({ url: session.url, total: q.total });
    } catch (e) {
      if (held && r) await repo.release(r.car, held.id).catch(() => {});   // don't leave dates blocked if Stripe failed
      if (e && e.type && String(e.type).startsWith("Stripe")) {
        console.error("[booking] Stripe error", e.type, e.message);
        // stripe_error is the Stripe error type/code only (no secrets), to make setup problems easy to spot
        return json({ error: "payment_unavailable", stripe_error: [e.type, e.code, e.param].filter(Boolean).join(":"), message: "Online payment isn't available right now. Please try again in a few minutes, or text us to book." }, 502);
      }
      return fail(e);
    }
  };
}

/** POST /api/cancel {car, ref} — renter came back from Stripe without paying */
export function cancelHandler({ store, stripe, now }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    try {
      const { car, ref } = await readJSON(req);
      if (!CARS[car] || typeof ref !== "string") return json({ ok: true });
      const b = await repo.get(car, ref);
      if (b && b.status === "hold") {
        if (b.sessionId) { try { await stripe.checkout.sessions.expire(b.sessionId); } catch (e) { /* already expired or completed */ } }
        await repo.release(car, ref);
      }
      return json({ ok: true });
    } catch (e) { return fail(e); }
  };
}

/** GET /api/booking?session_id=cs_... -> booking status for the confirmation screen */
export function bookingStatusHandler({ store, stripe, now }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    try {
      const sid = new URL(req.url).searchParams.get("session_id") || "";
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ error: "bad_request" }, 400);
      const s = await stripe.checkout.sessions.retrieve(sid);
      const m = s.metadata || {};
      if (!CARS[m.car]) return json({ error: "not_found" }, 404);
      let b = await repo.get(m.car, m.booking_id);
      // the webhook may not have arrived yet; if Stripe says it's paid, confirm now (idempotent)
      if (b && s.payment_status === "paid" && b.status !== "confirmed" && b.status !== "conflict")
        b = (await repo.confirm(m.car, b.id, customerOf(s))) || (await repo.get(m.car, b.id));
      return json({
        status: b ? b.status : "unknown", paid: s.payment_status === "paid",
        car: CARS[m.car].name, from: m.from, to: m.to, fromTime: m.from_time, toTime: m.to_time,
        location: LOCATIONS[m.location] ? LOCATIONS[m.location].name : "", total: s.amount_total, email: s.customer_details && s.customer_details.email,
      });
    } catch (e) {
      if (e && e.type && String(e.type).startsWith("Stripe")) return json({ error: "not_found" }, 404);
      return fail(e);
    }
  };
}

const customerOf = s => ({ customer: {
  name: s.customer_details && s.customer_details.name, email: s.customer_details && s.customer_details.email,
  phone: s.customer_details && s.customer_details.phone }, paymentIntent: s.payment_intent, amountPaid: s.amount_total });

/** POST /api/stripe-webhook — Stripe tells us when checkout is paid or expires */
export function webhookHandler({ store, stripe, webhookSecret, now }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    let event;
    try {
      const raw = await req.text();
      event = await stripe.webhooks.constructEventAsync(raw, req.headers.get("stripe-signature") || "", webhookSecret);
    } catch (e) {
      console.warn("[booking] webhook signature check failed", e.message);
      return json({ error: "bad_signature" }, 400);
    }
    try {
      const s = event.data.object, m = (s && s.metadata) || {};
      if (!CARS[m.car] || !m.booking_id) return json({ received: true, ignored: true });
      const paidNow = (event.type === "checkout.session.completed" && s.payment_status === "paid")
        || event.type === "checkout.session.async_payment_succeeded";      // e.g. bank payments that clear later
      if (paidNow) {
        const b = await repo.confirm(m.car, m.booking_id, customerOf(s));
        if (b && b.status === "conflict") console.error(`[booking] PAID BUT DATES TAKEN: refund needed for ${m.car} ${m.from}-${m.to}, session ${s.id}`);
      } else if (event.type === "checkout.session.completed") {
        await repo.extendHold(m.car, m.booking_id, 7 * 24 * 60);           // payment pending: keep the dates while it clears
      } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
        await repo.release(m.car, m.booking_id);
      }
      return json({ received: true });
    } catch (e) {
      console.error("[booking] webhook processing failed", e);
      return json({ error: "retry" }, 500);   // Stripe retries on 5xx
    }
  };
}

const keyOk = (req, adminKey) => {
  const got = req.headers.get("x-admin-key") || "";
  if (!adminKey || got.length !== adminKey.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ adminKey.charCodeAt(i);
  return diff === 0;
};

/** POST /api/admin/cancel {car, id} with header x-admin-key -> frees the dates (refund in Stripe separately) */
export function adminCancelHandler({ store, adminKey, now }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (!keyOk(req, adminKey)) return json({ error: "unauthorized" }, 401);
    try {
      const { car, id } = await readJSON(req);
      if (!CARS[car] || typeof id !== "string") return json({ error: "bad_request" }, 400);
      const b = await repo.cancel(car, id);
      return json({ ok: true, booking: b || (await repo.get(car, id)) });
    } catch (e) { return fail(e); }
  };
}

/** GET /api/admin/bookings with header x-admin-key -> all bookings (for the owner) */
export function adminHandler({ store, adminKey, now }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (!keyOk(req, adminKey)) return json({ error: "unauthorized" }, 401);
    const out = {};
    for (const c of Object.keys(CARS)) out[c] = await repo.all(c);
    return json(out);
  };
}
