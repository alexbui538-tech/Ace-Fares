// Payment links for post-trip charges the saved card couldn't cover.
// The renter's email links to /pay.html?car=&ref=&c=<charge id>&t=<token>. That page shows the itemized charge
// and, on "Pay", opens a fresh Stripe Checkout page (so the link never expires). Paid charges are marked
// from the Stripe webhook (checkout.session.completed, metadata.kind "charge_link") or when the renter returns.
import { timingSafeEqual } from "node:crypto";
import { CARS } from "./catalog.mjs";
import { makeRepo } from "./bookings.mjs";
import { niceDate } from "./pricing.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); };
const isStripe = e => e && e.type && String(e.type).startsWith("Stripe");

/** Mark a linked charge paid (idempotent). Returns the charge, or null. */
export async function markLinkPaid(store, { car, bookingId, chargeId, sessionId, paymentIntent, amount, now = () => Date.now(), notify = null }) {
  const repo = makeRepo(store, { now });
  let paidNow = null;
  await repo.change(car, bookingId, x => {
    const c = (x.charges || []).find(z => z.id === chargeId);
    if (!c || c.status === "paid") return undefined;
    Object.assign(c, { status: "paid", paidVia: "link", paidAt: new Date(now()).toISOString(), linkSessionId: sessionId || c.linkSessionId, ...(paymentIntent ? { paymentIntentId: paymentIntent } : {}), ...(amount ? { paidAmount: amount } : {}) });
    paidNow = { ...c, renter: (x.customer && x.customer.name) || x.accountName || "The renter", from: x.from };
    return x;
  });
  if (paidNow && notify) { try { await notify(`Paid: ${paidNow.label} for the ${CARS[car].name}`, `${paidNow.renter} paid $${(paidNow.total / 100).toFixed(2)} (${paidNow.label}) with the payment link.`); } catch {} }
  return paidNow;
}

export function payHandler({ store, stripe, siteUrl = "", now = () => Date.now(), notify = null, log = console }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    try {
      const url = new URL(req.url);
      let p = Object.fromEntries(url.searchParams);
      if (req.method === "POST") {
        const o = req.headers.get("origin"); if (o && new URL(o).host !== url.host) return json({ error: "bad_origin" }, 403);
        const t = await req.text(); if (t.length > 2048) return json({ error: "too_large" }, 413);
        try { p = JSON.parse(t || "{}") || {}; } catch { return json({ error: "bad_request" }, 400); }
      } else if (req.method !== "GET") return json({ error: "method" }, 405);
      const nope = json({ error: "not_found", message: "This payment link isn't valid. Text us at (972) 994-6413." }, 404);
      const car = p.car, ref = String(p.ref || ""), cid = String(p.c || "");
      if (!CARS[car] || !/^[0-9a-f-]{36}$/.test(ref) || !/^[0-9a-f]{12}$/.test(cid)) return nope;
      const b = await repo.get(car, ref);
      let c = b && (b.charges || []).find(x => x.id === cid);
      if (!c || !same(p.t, c.payToken)) return nope;
      // back from Stripe: confirm the payment ourselves in case the webhook hasn't arrived yet
      if (c.status !== "paid" && c.linkSessionId) {
        try {
          const s = await stripe.checkout.sessions.retrieve(c.linkSessionId);
          if (s.payment_status === "paid") c = (await markLinkPaid(store, { car, bookingId: ref, chargeId: cid, sessionId: s.id, paymentIntent: s.payment_intent, amount: s.amount_total, now, notify })) || { ...c, status: "paid" };
        } catch (e) { if (!isStripe(e)) throw e; }
      }
      const info = { carName: CARS[car].name, from: b.from, to: b.to, label: c.label, lines: c.lines, total: c.total, note: c.note || "", status: c.status === "paid" ? "paid" : "due" };
      if (req.method === "GET") return json(info);
      if (info.status === "paid") return json({ ...info, message: "This charge is already paid. Thank you!" }, 409);
      const back = `${siteUrl}/pay.html?car=${car}&ref=${ref}&c=${cid}&t=${encodeURIComponent(p.t)}`;
      const meta = { kind: "charge_link", car, booking_id: ref, charge_id: cid };
      const s = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: c.lines.map(l => ({ quantity: 1, price_data: { currency: "usd", unit_amount: l.amount, product_data: { name: l.label } } })),
        ...(b.customerId ? { customer: b.customerId } : (b.customer && b.customer.email ? { customer_email: b.customer.email } : {})),
        metadata: meta,
        payment_intent_data: { metadata: meta, description: `${c.label}: ${CARS[car].name}, ${niceDate(b.from)} to ${niceDate(b.to)}` },
        success_url: back + "&paid=1", cancel_url: back,
      });
      await repo.change(car, ref, x => { const y = (x.charges || []).find(z => z.id === cid); if (!y) return undefined; y.linkSessionId = s.id; return x; });
      return json({ url: s.url });
    } catch (e) {
      if (isStripe(e)) { log.error("[pay] Stripe error", e.message); return json({ error: "stripe", message: "Payment isn't available right now. Please try again in a few minutes." }, 502); }
      log.error("[pay] error", e);
      return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
    }
  };
}
