// End-to-end booking flow against a local Netlify Blobs server and a fake Stripe.
// Uses Stripe's real webhook signature code, so signature checks are genuine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { availabilityHandler, checkoutHandler, checkoutDetailsHandler, cancelHandler, bookingStatusHandler, webhookHandler, adminHandler, adminCancelHandler, agreementPageHandler } from "../lib/handlers.mjs";
import { AGREEMENT_VERSION } from "../lib/agreement.mjs";
import { localBlobs, fakeStripe, signedEvent, post, get, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

let blobs; before(async () => { blobs = await localBlobs(); }); after(async () => { await blobs.stop(); });

const fakeMailer = (fail = false) => { const sent = []; return { sent, async send(m) { if (fail) throw new Error("SMTP login failed"); sent.push(m); } }; };
const setup = (opts = {}) => {
  const stripe = fakeStripe(opts), now = () => opts.now ? opts.now() : NOW, store = blobs.store;
  const mailer = opts.mailer || null, siteUrl = "https://acefares.test";
  return { stripe, mailer,
    avail: availabilityHandler({ store, now }),
    checkout: checkoutHandler({ store, stripe, siteUrl, now, requireTerms: !!opts.requireTerms, publishableKey: opts.pk || "" }),
    details: checkoutDetailsHandler({ store, stripe, publishableKey: opts.pk || "", now }),
    cancel: cancelHandler({ store, stripe, now }),
    status: bookingStatusHandler({ store, stripe, now, mailer, siteUrl }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now, mailer, siteUrl }),
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
  assert.deepEqual(p.line_items.map(l => l.price_data.unit_amount), [109440, 12500, 12194]);  // Wed-Sat: 2x$259 + 2x$349 -10%, DFW $125, 10% tax
  assert.match(p.line_items[0].price_data.product_data.description, /2 Mon-Thu at \$259, 2 Fri-Sun at \$349/);
  assert.equal(r.data.total, 134134);
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
  assert.equal(st.data.status, "confirmed"); assert.equal(st.data.total, 134134); assert.equal(st.data.email, "renter@example.com");

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

test("paid booking emails the renter their confirmation and rental agreement, once", async () => {
  const mailer = fakeMailer(); const s = setup({ mailer });
  await s.checkout(post("/api/checkout", body({ car: "srx", from: "2027-06-07", to: "2027-06-10" })));
  const sess = s.stripe.pay("cs_test_1");
  await s.hook(signedEvent("checkout.session.completed", sess));
  await s.hook(signedEvent("checkout.session.completed", sess));     // Stripe retry
  await s.status(get("/api/booking?session_id=cs_test_1"));          // confirmation page check
  assert.equal(mailer.sent.length, 1);
  const m = mailer.sent[0];
  assert.equal(m.to, "renter@example.com");
  assert.match(m.subject, /Booking confirmed: Cadillac SRX/);
  assert.match(m.html, /Your rental agreement/); assert.match(m.html, /Renter: Test Renter/); assert.match(m.html, /Cadillac SRX/);
  assert.match(m.text, /YOUR RENTAL AGREEMENT/);
  const all = await j(await s.admin(new Request("https://x/api/admin/bookings", { headers: { "x-admin-key": "secret-admin" } })));
  assert.ok(all.data.srx.find(b => b.from === "2027-06-07").emailedAt);
});

test("if the email fails, the booking is still confirmed and the failure is recorded", async () => {
  const s = setup({ mailer: fakeMailer(true) });
  await s.checkout(post("/api/checkout", body({ car: "srx", from: "2027-07-12", to: "2027-07-14" })));
  assert.equal((await s.hook(signedEvent("checkout.session.completed", s.stripe.pay("cs_test_1")))).status, 200);
  const all = await j(await s.admin(new Request("https://x/api/admin/bookings", { headers: { "x-admin-key": "secret-admin" } })));
  const b = all.data.srx.find(x => x.from === "2027-07-12");
  assert.equal(b.status, "confirmed"); assert.match(b.emailError, /SMTP/);
});

test("agreement box at checkout when switched on, and acceptance is recorded", async () => {
  const off = setup(); await off.checkout(post("/api/checkout", body({ car: "van", from: "2027-08-16", to: "2027-08-18" })));
  assert.equal(off.stripe.calls.create[0].params.consent_collection, undefined);
  const s = setup({ requireTerms: true });
  await s.checkout(post("/api/checkout", body({ car: "van", from: "2027-08-20", to: "2027-08-22" })));
  const p = s.stripe.calls.create[0].params;
  assert.deepEqual(p.consent_collection, { terms_of_service: "required" });
  assert.match(p.custom_text.terms_of_service_acceptance.message, /\(https:\/\/acefares\.test\/rental-agreement\)/);
  const sess = Object.assign(s.stripe.pay("cs_test_1"), { consent: { terms_of_service: "accepted" } });
  await s.hook(signedEvent("checkout.session.completed", sess));
  const all = await j(await s.admin(new Request("https://x/api/admin/bookings", { headers: { "x-admin-key": "secret-admin" } })));
  assert.equal(all.data.van.find(b => b.from === "2027-08-20").termsAccepted, true);
});

test("rental agreement page renders with the owner's terms filled in", async () => {
  const res = await agreementPageHandler()(get("/rental-agreement"));
  const html = await res.text();
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(html, /Rental Agreement/); assert.match(html, /Who may drive/); assert.match(html, /at least 18/);
  assert.doesNotMatch(html, /\[to be set\]/);
  for (const w of ["$3 per mile", "30-minute grace period, a $50 late fee", "$30 service fee", "cleaning fee of $30", "full refund within 24 hours after you book", "minus a $20 cancellation fee", "Do not take the vehicle outside Texas", "366.178"]) assert.ok(html.includes(w), w);
});


/* ---------- on-site checkout page (Stripe Payment Element) ---------- */
const PK = "pk_test_123";
const renter = { name: "Jordan Lee", email: "Jordan@Example.com", phone: "(214) 555-0100", agree: true, termsVersion: AGREEMENT_VERSION, insurance: { choice: "own", company: "State Farm", policy: "SF-123" } };

test("on-site checkout: hold + payment created, summary shown, details saved, paid webhook confirms and emails once", async () => {
  const mailer = fakeMailer(), s = setup({ pk: PK, mailer });
  const r = await j(await s.checkout(post("/api/checkout", body({ car: "bmw", from: "2027-05-06", to: "2027-05-09", location: "dallas-delivery" }))));
  assert.equal(r.status, 200); assert.match(r.data.checkout, /^\/checkout\.html\?car=bmw&ref=[0-9a-f-]{36}$/);
  assert.equal(s.stripe.calls.create.length, 0, "no hosted Stripe page");
  const pc = s.stripe.calls.piCreate[0];
  assert.equal(pc.params.amount, r.data.total); assert.deepEqual(pc.params.automatic_payment_methods, { enabled: true });
  // Thu May 6 2027 + Fri + Sat = 139 + 2*199 = 537, 10% off = 483.30, +$100 delivery, 10% tax on 583.30 = 58.33 -> 641.63
  assert.equal(r.data.total, 64163);
  const ref = r.data.ref;

  const g = await j(await s.details(get(`/api/checkout-details?car=bmw&ref=${ref}`)));
  assert.equal(g.status, 200); assert.equal(g.data.publishableKey, PK); assert.equal(g.data.clientSecret, "pi_test_1_secret_abc");
  assert.equal(g.data.summary.total, 64163); assert.equal(g.data.summary.weekdays, 1); assert.equal(g.data.summary.weekends, 2);
  assert.equal(g.data.summary.miles, 300); assert.equal(g.data.summary.location, "Delivery"); assert.equal(g.data.summary.photo, "bmw-1");

  // renter details: checked, saved, and passed to Stripe for the receipt
  for (const [bad, code] of [[{ name: "" }, "bad_name"], [{ email: "nope" }, "bad_email"], [{ phone: "123" }, "bad_phone"], [{ agree: false }, "agree_required"]]) {
    const x = await j(await s.details(post("/api/checkout-details", { car: "bmw", ref, ...renter, ...bad })));
    assert.equal(x.status, 400); assert.equal(x.data.error, code);
  }
  const d = await j(await s.details(post("/api/checkout-details", { car: "bmw", ref, ...renter, deliveryAddress: "123 Main St, Dallas, TX 75201" })));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(s.stripe.calls.piUpdate.at(-1).params.receipt_email, "jordan@example.com");

  // pays -> webhook -> confirmed, emailed once, dates blocked
  const pi = s.stripe.payIntent("pi_test_1");
  assert.equal((await s.hook(signedEvent("payment_intent.succeeded", pi))).status, 200);
  assert.equal((await s.hook(signedEvent("payment_intent.succeeded", pi))).status, 200);   // retry is harmless
  assert.equal(mailer.sent.length, 1); assert.equal(mailer.sent[0].to, "jordan@example.com");
  const st = await j(await s.status(get("/api/booking?payment_intent=pi_test_1")));
  assert.equal(st.data.status, "confirmed"); assert.equal(st.data.total, 64163); assert.equal(st.data.email, "jordan@example.com");
  const all = await j(await s.admin(new Request("https://x/api/admin/bookings", { headers: { "x-admin-key": "secret-admin" } })));
  const bk = all.data.bmw.find(x => x.id === ref);
  assert.equal(bk.customer.name, "Jordan Lee"); assert.equal(bk.termsAccepted, true); assert.equal(bk.amountPaid, 64163);
  assert.equal((await s.checkout(post("/api/checkout", body({ car: "bmw", from: "2027-05-07", to: "2027-05-08" })))).status, 409);
  // the checkout link no longer offers a payment form
  const g2 = await j(await s.details(get(`/api/checkout-details?car=bmw&ref=${ref}`)));
  assert.equal(g2.data.status, "confirmed"); assert.equal(g2.data.clientSecret, undefined);
});

test("on-site checkout: confirmation page confirms even before the webhook arrives", async () => {
  const s = setup({ pk: PK });
  const r = await j(await s.checkout(post("/api/checkout", body({ car: "van", from: "2027-06-01", to: "2027-06-03" }))));
  await s.details(post("/api/checkout-details", { car: "van", ref: r.data.ref, ...renter }));
  s.stripe.payIntent("pi_test_1");
  assert.equal((await j(await s.status(get("/api/booking?payment_intent=pi_test_1")))).data.status, "confirmed");
});

test("on-site checkout: declined card keeps the dates for a retry; a failed delayed payment releases them", async () => {
  const s = setup({ pk: PK });
  const a = await j(await s.checkout(post("/api/checkout", body({ car: "srx", from: "2027-07-01", to: "2027-07-03" }))));
  await s.hook(signedEvent("payment_intent.payment_failed", s.stripe.intents.get("pi_test_1")));
  const st = await j(await s.status(get("/api/booking?payment_intent=pi_test_1")));
  assert.equal(st.data.status, "failed"); assert.equal(st.data.ref, a.data.ref);
  assert.equal((await j(await s.avail(get("/api/availability")))).data.cars.srx.filter(x => x.from === "2027-07-01").length, 1, "still held");

  const b = await j(await s.checkout(post("/api/checkout", body({ car: "srx", from: "2027-08-01", to: "2027-08-03" }))));
  await s.hook(signedEvent("payment_intent.processing", s.stripe.payIntent("pi_test_2", "processing")));
  await s.hook(signedEvent("payment_intent.payment_failed", s.stripe.payIntent("pi_test_2", "requires_payment_method")));
  assert.equal((await j(await s.avail(get("/api/availability")))).data.cars.srx.filter(x => x.from === "2027-08-01").length, 0, "released");
  assert.ok(b.data.ref);
});

test("on-site checkout: Back cancels the payment and frees the dates", async () => {
  const s = setup({ pk: PK });
  const r = await j(await s.checkout(post("/api/checkout", body({ car: "escalade", from: "2027-09-01", to: "2027-09-03" }))));
  await s.cancel(post("/api/cancel", { car: "escalade", ref: r.data.ref }));
  assert.deepEqual(s.stripe.calls.piCancel, ["pi_test_1"]);
  assert.equal((await j(await s.avail(get("/api/availability")))).data.cars.escalade.filter(x => x.from === "2027-09-01").length, 0);
  const g = await j(await s.details(get(`/api/checkout-details?car=escalade&ref=${r.data.ref}`)));
  assert.equal(g.data.clientSecret, undefined);
});

test("on-site checkout: an expired hold is renewed if the dates are still free, refused if someone took them", async () => {
  let t = NOW; const s = setup({ pk: PK, now: () => t });
  const r1 = await j(await s.checkout(post("/api/checkout", body({ car: "van", from: "2027-10-01", to: "2027-10-03" }))));
  t += 40 * 60e3;   // renter took 40 minutes; hold lapsed but nobody else booked
  assert.equal((await s.details(post("/api/checkout-details", { car: "van", ref: r1.data.ref, ...renter }))).status, 200);
  const r2 = await j(await s.checkout(post("/api/checkout", body({ car: "van", from: "2027-11-01", to: "2027-11-03" }))));
  t += 40 * 60e3;   // this one lapsed and someone else grabbed the dates
  await s.checkout(post("/api/checkout", body({ car: "van", from: "2027-11-02", to: "2027-11-04" })));
  const x = await j(await s.details(post("/api/checkout-details", { car: "van", ref: r2.data.ref, ...renter })));
  assert.equal(x.status, 409); assert.equal(x.data.error, "unavailable");
});

test("on-site checkout: without a publishable key the site still uses Stripe's hosted page", async () => {
  const s = setup();
  const r = await j(await s.checkout(post("/api/checkout", body({ car: "srx", from: "2027-12-01", to: "2027-12-03" }))));
  assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com\//); assert.equal(s.stripe.calls.piCreate.length, 0);
});

test("on-site checkout: bad links are rejected", async () => {
  const s = setup({ pk: PK });
  assert.equal((await s.details(get("/api/checkout-details?car=bmw&ref=not-a-ref"))).status, 404);
  assert.equal((await s.details(get("/api/checkout-details?car=bmw&ref=00000000-0000-0000-0000-000000000000"))).status, 404);
  assert.equal((await s.status(get("/api/booking?payment_intent=<x>"))).status, 400);
});
