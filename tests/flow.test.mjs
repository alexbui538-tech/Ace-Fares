// End-to-end booking flow against a local Netlify Blobs server and a fake Stripe.
// Uses Stripe's real webhook signature code, so signature checks are genuine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { availabilityHandler, checkoutHandler, cancelHandler, bookingStatusHandler, webhookHandler, adminHandler, adminCancelHandler } from "../lib/handlers.mjs";
import { localBlobs, fakeStripe, signedEvent, post, get, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

let blobs; before(async () => { blobs = await localBlobs(); }); after(async () => { await blobs.stop(); });

const setup = (opts = {}) => {
  const stripe = fakeStripe(opts), now = () => opts.now ? opts.now() : NOW, store = blobs.store;
  return { stripe,
    avail: availabilityHandler({ store, now }),
    checkout: checkoutHandler({ store, stripe, siteUrl: "https://acefares.test", now }),
    cancel: cancelHandler({ store, stripe, now }),
    status: bookingStatusHandler({ store, stripe, now }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now }),
    admin: adminHandler({ store, adminKey: "secret-admin", now }),
    adminCancel: adminCancelHandler({ store, adminKey: "secret-admin", now }) };
};
const body = (o = {}) => ({ car: "escalade", from: "2026-11-04", to: "2026-11-08", fromTime: "10:00", toTime: "18:00", location: "dfw", ...o });
const j = async res => ({ status: res.status, data: await res.json() });

test("full booking: checkout -> Stripe session -> paid webhook -> confirmed and blocked", async () => {
  const s = setup();
  const r = await j(await s.checkout(post("/api/checkout", body())));
  assert.equal(r.status, 200); assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com\//);

  // what was sent to Stripe: server-computed prices, card payments, 30 min expiry, return URLs
  const p = s.stripe.calls.create[0].params;
  assert.deepEqual(p.line_items.map(l => l.price_data.unit_amount), [108000, 12500, 12050]);  // Wed-Sat: 2x$250 + 2x$350 -10%, DFW $125, 10% tax
  assert.match(p.line_items[0].price_data.product_data.description, /2 Mon-Thu at \$250, 2 Fri-Sun at \$350/);
  assert.equal(r.data.total, 132550);
  assert.equal(p.payment_method_types, undefined);   // methods come from the Stripe Dashboard
  assert.equal(p.expires_at, Math.floor(NOW / 1000) + 31 * 60);
  assert.match(p.success_url, /booking=success&session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.equal(p.metadata.car, "escalade"); assert.equal(s.stripe.calls.create[0].opts.idempotencyKey.startsWith("checkout-"), true);

  // while in checkout the dates are held
  assert.deepEqual((await j(await s.avail(get("/api/availability")))).data.cars.escalade, [{ from: "2026-11-04", to: "2026-11-08" }]);
  const clash = await j(await s.checkout(post("/api/checkout", body({ from: "2026-11-07", to: "2026-11-10" }))));
  assert.equal(clash.status, 409); assert.equal(clash.data.error, "unavailable");

  // renter pays; Stripe sends the signed webhook
  const sess = s.stripe.pay("cs_test_1");
  assert.equal((await s.hook(signedEvent("checkout.session.completed", sess))).status, 200);
  const st = await j(await s.status(get("/api/booking?session_id=cs_test_1")));
  assert.equal(st.data.status, "confirmed"); assert.equal(st.data.total, 132550); assert.equal(st.data.email, "renter@example.com");

  // webhook retries are harmless, and a paid booking can't be cancelled from the return link
  assert.equal((await s.hook(signedEvent("checkout.session.completed", sess))).status, 200);
  const ref = new URL(p.cancel_url).searchParams.get("ref");
  await s.cancel(post("/api/cancel", { car: "escalade", ref }));
  assert.equal((await j(await s.status(get("/api/booking?session_id=cs_test_1")))).data.status, "confirmed");

  // 1-day turnaround: returned Nov 8, next pickup Nov 9 is allowed
  assert.equal((await s.checkout(post("/api/checkout", body({ from: "2026-11-09", to: "2026-11-11" })))).status, 200);
});

test("renter cancels checkout: Stripe session expired and dates released", async () => {
  const s = setup();
  await s.checkout(post("/api/checkout", body({ car: "srx" })));
  const p = s.stripe.calls.create[0].params, ref = new URL(p.cancel_url).searchParams.get("ref");
  assert.equal((await s.cancel(post("/api/cancel", { car: "srx", ref }))).status, 200);
  assert.deepEqual(s.stripe.calls.expire, ["cs_test_1"]);
  assert.deepEqual((await j(await s.avail(get("/api/availability")))).data.cars.srx, []);
});

test("checkout session expires (renter walked away): webhook releases the dates", async () => {
  const s = setup();
  await s.checkout(post("/api/checkout", body({ car: "bmw" })));
  const sess = s.stripe.sessions.get("cs_test_1"); sess.status = "expired";
  assert.equal((await s.hook(signedEvent("checkout.session.expired", sess))).status, 200);
  assert.deepEqual((await j(await s.avail(get("/api/availability")))).data.cars.bmw, []);
});

test("webhook with a bad signature is rejected and changes nothing", async () => {
  const s = setup();
  await s.checkout(post("/api/checkout", body({ car: "van" })));
  const forged = signedEvent("checkout.session.completed", s.stripe.pay("cs_test_1"), "whsec_wrong");
  assert.equal((await s.hook(forged)).status, 400);
  const all = await j(await s.admin(new Request("https://x/api/admin/bookings", { headers: { "x-admin-key": "secret-admin" } })));
  assert.equal(all.data.van.at(-1).status, "hold");
});

test("confirmation page works even if the webhook hasn't arrived yet", async () => {
  const s = setup();
  await s.checkout(post("/api/checkout", body({ car: "van", from: "2026-12-01", to: "2026-12-03" })));
  s.stripe.pay("cs_test_1");
  assert.equal((await j(await s.status(get("/api/booking?session_id=cs_test_1")))).data.status, "confirmed");
});

test("Stripe down: renter gets a clear error and the dates aren't left blocked", async () => {
  const s = setup({ failCreate: true });
  const r = await j(await s.checkout(post("/api/checkout", body({ car: "srx", from: "2027-01-10", to: "2027-01-12" }))));
  assert.equal(r.status, 502); assert.equal(r.data.error, "payment_unavailable");
  assert.ok(!(await j(await s.avail(get("/api/availability")))).data.cars.srx.some(b => b.from === "2027-01-10"));
});

test("bad input never reaches Stripe", async () => {
  const s = setup();
  for (const b of [body({ from: "2026-10-01" }), body({ car: "nope" }), body({ to: "2026-11-04" }), "not json"]) {
    const res = await s.checkout(new Request("https://x/api/checkout", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) }));
    assert.equal(res.status, 400);
  }
  assert.equal(s.stripe.calls.create.length, 0);
  assert.equal((await s.checkout(get("/api/checkout"))).status, 405);
});

test("admin list needs the admin key; unknown session ids are rejected", async () => {
  const s = setup();
  assert.equal((await s.admin(get("/api/admin/bookings"))).status, 401);
  assert.equal((await s.status(get("/api/booking?session_id=cs_test_999"))).status, 404);
  assert.equal((await s.status(get("/api/booking?session_id=<script>"))).status, 400);
});

// Note: the double-booking race is tested in bookings.test.mjs with a store that
// enforces version checks the way Netlify Blobs does. The local Blobs emulator does
// not enforce them atomically, so the same check against real Netlify storage is
// done after deploy with scripts/live-checks.mjs.

test("bank-style payment: pending keeps the dates, cleared confirms, failed releases", async () => {
  const s = setup();
  await s.checkout(post("/api/checkout", body({ car: "escalade", from: "2027-03-01", to: "2027-03-03" })));
  await s.checkout(post("/api/checkout", body({ car: "escalade", from: "2027-04-01", to: "2027-04-03" })));
  const a = s.stripe.sessions.get("cs_test_1"), b = s.stripe.sessions.get("cs_test_2");
  a.status = b.status = "complete";   // checkout finished, money not yet received
  await s.hook(signedEvent("checkout.session.completed", a));
  await s.hook(signedEvent("checkout.session.completed", b));
  const all = async () => j(await s.admin(new Request("https://x/api/admin/bookings", { headers: { "x-admin-key": "secret-admin" } })));
  let esc = (await all()).data.escalade;
  const find = from => esc.find(x => x.from === from);
  assert.equal(find("2027-03-01").status, "hold"); assert.ok(find("2027-03-01").pendingPayment);
  assert.ok(Date.parse(find("2027-03-01").expiresAt) > NOW + 6 * 864e5, "held for days while the payment clears");
  await s.hook(signedEvent("checkout.session.async_payment_succeeded", { ...a, payment_status: "paid" }));
  await s.hook(signedEvent("checkout.session.async_payment_failed", b));
  esc = (await all()).data.escalade;
  assert.equal(find("2027-03-01").status, "confirmed");
  assert.equal(find("2027-04-01").status, "released");
});

test("owner cancels a paid booking from the bookings page: dates free up; wrong key refused", async () => {
  const s = setup();
  await s.checkout(post("/api/checkout", body({ car: "bmw", from: "2027-05-07", to: "2027-05-09" })));
  await s.hook(signedEvent("checkout.session.completed", s.stripe.pay("cs_test_1")));
  const id = s.stripe.calls.create[0].params.metadata.booking_id;
  const asOwner = (key) => new Request("https://x/api/admin/cancel", { method: "POST", body: JSON.stringify({ car: "bmw", id }), headers: { "x-admin-key": key } });
  assert.equal((await s.adminCancel(asOwner("wrong-key-12"))).status, 401);
  assert.ok((await j(await s.avail(get("/api/availability")))).data.cars.bmw.some(b => b.from === "2027-05-07"));
  const r = await j(await s.adminCancel(asOwner("secret-admin")));
  assert.equal(r.data.booking.status, "cancelled");
  assert.ok(!(await j(await s.avail(get("/api/availability")))).data.cars.bmw.some(b => b.from === "2027-05-07"));
});
