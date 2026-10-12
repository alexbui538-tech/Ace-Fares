// Clickwrap signature ledger and security deposit holds.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { checkoutHandler, checkoutDetailsHandler, bookingStatusHandler, webhookHandler, adminDepositHandler } from "../lib/handlers.mjs";
import { makeDeposits, localMs, placeAt, releaseAt } from "../lib/deposits.mjs";
import { AGREEMENT_VERSION, agreementText, agreementSections, clickwrapText } from "../lib/agreement.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { DEPOSITS, SMOKING_FEE } from "../lib/catalog.mjs";
import { localBlobs, fakeStripe, signedEvent, post, get, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

let blobs; before(async () => { blobs = await localBlobs(); }); after(async () => { await blobs.stop(); });
const PK = "pk_test_123", KEY = "secret-admin";
const j = async res => ({ status: res.status, data: await res.json() });
const renter = { name: "Jordan Lee", email: "jordan@example.com", phone: "(214) 555-0100", agree: true, termsVersion: AGREEMENT_VERSION, insurance: { choice: "own", company: "State Farm", policy: "SF-123" } };
const H = 3600e3;
const quiet = { error() {}, warn() {}, log() {} };

function setup(opts = {}) {
  let t = opts.t || NOW; const now = () => t, store = blobs.store;
  const notices = [], notify = async (subject, text) => notices.push({ subject, text });
  const stripe = fakeStripe({ clock: now, declineHolds: !!opts.declineHolds });
  return {
    stripe, notices, store, setTime: x => { t = x; }, now,
    checkout: checkoutHandler({ store, stripe, siteUrl: "https://acefares.test", now, publishableKey: opts.hosted ? "" : PK }),
    details: checkoutDetailsHandler({ store, stripe, publishableKey: PK, now }),
    status: bookingStatusHandler({ store, stripe, now, notify }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now, notify }),
    adminDep: adminDepositHandler({ store, stripe, adminKey: KEY, now, notify }),
    deposits: makeDeposits({ store, stripe, now, notify, log: quiet }),
    repo: makeRepo(store, { now }),
  };
}
const trip = o => ({ car: "bmw", from: "2027-03-02", to: "2027-03-05", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup", ...o });
const sign = (s, car, ref, extra = {}) => s.details(new Request("https://site.test/api/checkout-details", {
  method: "POST", body: JSON.stringify({ car, ref, ...renter, agreedAt: new Date(s.now() - 5000).toISOString(), ...extra }),
  headers: { "content-type": "application/json", "x-nf-client-connection-ip": "203.0.113.7", "user-agent": "TestBrowser/1.0" } }));
const admin = (s, b) => s.adminDep(new Request("https://x/api/admin/deposit", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", "x-admin-key": KEY } }));

async function book(s, o = {}) {
  const r = await j(await s.checkout(post("/api/checkout", trip(o))));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const car = o.car || "bmw";
  assert.equal((await sign(s, car, r.data.ref)).status, 200);
  const b = await s.repo.get(car, r.data.ref);
  const pi = s.stripe.payIntent(b.paymentIntentId);
  assert.equal((await s.hook(signedEvent("payment_intent.succeeded", pi))).status, 200);
  return { car, ref: r.data.ref, pi };
}

test("agreement has the direct-lessor, deposit, insurance, smoking and Dallas County clauses", () => {
  const text = agreementText(trip({ customer: { name: "Jordan Lee" } }));
  assert.match(text, /owner and lessor of the vehicle/); assert.match(text, /not a peer-to-peer car sharing platform/);
  assert.match(text, /Security deposit hold/); assert.match(text, /\$500 for this vehicle/); assert.match(text, /up to 10 business days/);
  assert.match(text, /601\.072/); assert.match(text, /Texas Business and Commerce Code, Chapter 322/);
  assert.match(text, new RegExp(`smoking remediation fee of \\$${SMOKING_FEE}`)); assert.match(text, /not negotiable/);
  assert.match(text, /Dallas County, Texas/); assert.doesNotMatch(text, /Collin/);
  assert.match(text, /TO THE FULLEST EXTENT PERMITTED BY TEXAS LAW, YOU AGREE TO DEFEND, INDEMNIFY/);  // conspicuous
  assert.match(agreementText(null), /2021 Cadillac Escalade: \$750/);
  assert.ok(agreementSections(null).length >= 18);
  const words = clickwrapText({ total: "$500.00", deposit: 500 });
  assert.equal(words, "I agree to pay the total shown ($500.00) and to the Ace Fares Rental Agreement, including the security deposit hold, no-smoking policy and cancellation policy. I agree to sign and receive records electronically, and I acknowledge the privacy policy.");
});

test("checkout shows the terms, saves the card for the deposit, and records the clickwrap signature in Stripe", async () => {
  const s = setup();
  const r = await j(await s.checkout(post("/api/checkout", trip({ from: "2027-02-02", to: "2027-02-05" }))));
  const pc = s.stripe.calls.piCreate[0].params;
  assert.equal(pc.setup_future_usage, "off_session"); assert.equal(pc.metadata.deposit_hold_amount, "500.00");
  const g = await j(await s.details(get(`/api/checkout-details?car=bmw&ref=${r.data.ref}`)));
  assert.equal(g.data.terms.version, AGREEMENT_VERSION); assert.equal(g.data.terms.deposit, DEPOSITS.bmw); assert.equal(g.data.terms.smokingFee, 150);
  assert.match(g.data.terms.clickwrap, /^I agree to pay the total shown/); assert.equal(g.data.terms.clickwrapLinks.length, 6); assert.match(g.data.terms.depositTiming, /24 hours before pickup/);

  // an outdated version of the terms can't be signed
  const old = await j(await sign(s, "bmw", r.data.ref, { termsVersion: "2020-01-01" }));
  assert.equal(old.status, 409); assert.equal(old.data.error, "terms_changed");

  const d = await j(await sign(s, "bmw", r.data.ref));
  assert.equal(d.status, 200); assert.match(d.data.sha256, /^[0-9a-f]{64}$/);
  const b = await s.repo.get("bmw", r.data.ref), sig = b.signature;
  assert.equal(sig.ip, "203.0.113.7"); assert.equal(sig.userAgent, "TestBrowser/1.0"); assert.equal(sig.signedAt, new Date(NOW).toISOString());
  assert.equal(sig.clientTime, new Date(NOW - 5000).toISOString()); assert.equal(sig.agreementVersion, AGREEMENT_VERSION);
  assert.equal(sig.depositAck, true); assert.equal(sig.smokingAck, true); assert.equal(sig.depositAmount, 50000);

  // Stripe ledger on the payment, and a customer for the saved card
  const up = s.stripe.calls.piUpdate.at(-1).params;
  assert.equal(up.customer, "cus_test_1"); assert.equal(s.stripe.calls.cusCreate[0].email, "jordan@example.com");
  assert.deepEqual(Object.fromEntries(Object.entries(up.metadata).filter(([k]) => /^(contract|signer|deposit|smoking)/.test(k))), {
    contract_signed: "true", contract_method: "clickwrap_checkbox", contract_signed_at: sig.signedAt, contract_client_time: sig.clientTime,
    contract_version: AGREEMENT_VERSION, contract_sha256: sig.sha256, signer_ip: "203.0.113.7", signer_user_agent: "TestBrowser/1.0",
    deposit_policy_ack: "true", deposit_hold_amount: "500.00", smoking_policy_ack: "true", smoking_fee: "150.00" });
  for (const [k, v] of Object.entries(up.metadata)) { assert.ok(k.length <= 40, k); assert.ok(String(v).length <= 500, k); }

  // full signed copy kept separately
  const copy = (await s.store.getWithMetadata(`signed-agreement-${r.data.ref}`, { type: "json" })).data;
  assert.equal(copy.sha256, sig.sha256); assert.match(copy.text, /Renter: Jordan Lee/);

  // signing again (e.g. after a declined card) updates the same customer
  await sign(s, "bmw", r.data.ref);
  assert.equal(s.stripe.calls.cusCreate.length, 1); assert.equal(s.stripe.calls.cusUpdate.length, 1);
});

test("deposit: pickup within 24 hours -> hold placed right after payment; deposit events never touch the rental", async () => {
  const s = setup();
  const { car, ref } = await book(s, { from: "2026-10-13", to: "2026-10-15" });   // NOW is Oct 12 noon
  const b = await s.repo.get(car, ref), d = b.deposit;
  assert.equal(d.status, "held"); assert.equal(d.amount, 50000);
  const hold = s.stripe.calls.piCreate.find(c => c.params.capture_method === "manual").params;
  assert.equal(hold.off_session, true); assert.equal(hold.confirm, true); assert.equal(hold.customer, "cus_test_1"); assert.equal(hold.payment_method, "pm_test_visa");
  assert.equal(hold.metadata.kind, "deposit"); assert.equal(hold.metadata.contract_sha256, b.signature.sha256);
  assert.equal(hold.payment_method_options.card.request_extended_authorization, "if_available");

  // the hold expiring at Stripe marks the deposit released and leaves the booking paid
  const hpi = s.stripe.intents.get(d.paymentIntentId); hpi.status = "canceled"; hpi.cancellation_reason = "automatic";
  assert.equal((await j(await s.hook(signedEvent("payment_intent.canceled", hpi)))).data.deposit, true);
  const after = await s.repo.get(car, ref);
  assert.equal(after.status, "confirmed"); assert.equal(after.deposit.status, "released"); assert.equal(after.deposit.releaseReason, "hold expired");
  assert.equal((await s.status(get(`/api/booking?payment_intent=${d.paymentIntentId}`))).status, 404, "deposit is not a booking payment");
});

test("deposit: later pickup is scheduled, placed 24h before, kept by the owner, and partly collected", async () => {
  const s = setup();
  const { car, ref } = await book(s);
  let b = await s.repo.get(car, ref);
  assert.equal(b.deposit.status, "scheduled"); assert.equal(Date.parse(b.deposit.placeAt), localMs("2027-03-02", "10:00") - 24 * H);
  assert.equal(new Date(localMs("2027-03-02", "10:00")).toISOString(), "2027-03-02T16:00:00.000Z");   // CST

  await s.deposits.sweep(); assert.equal((await s.repo.get(car, ref)).deposit.status, "scheduled", "not yet");
  s.setTime(placeAt(b) + 60e3); await s.deposits.sweep();
  b = await s.repo.get(car, ref); assert.equal(b.deposit.status, "held");

  // wrong key / bad amount
  assert.equal((await s.adminDep(new Request("https://x", { method: "POST", body: "{}", headers: { "x-admin-key": "nope" } }))).status, 401);
  assert.equal((await admin(s, { car, id: ref, action: "capture", amount: 900 })).status, 400);
  // owner keeps the hold, so the automatic release is skipped
  await admin(s, { car, id: ref, action: "keep" });
  s.setTime(releaseAt(b) + 60e3); await s.deposits.sweep();
  assert.equal((await s.repo.get(car, ref)).deposit.status, "held");
  // owner collects the smoking fee; Stripe releases the rest
  const c = await j(await admin(s, { car, id: ref, action: "capture", amount: 150, note: "Smoking remediation fee" }));
  assert.equal(c.status, 200); assert.equal(c.data.deposit.status, "captured"); assert.equal(c.data.deposit.capturedAmount, 15000);
  assert.deepEqual(s.stripe.calls.piCapture.at(-1).params, { amount_to_capture: 15000 });
});

test("deposit: renewed for long rentals, released after return, and a declined hold alerts the owner", async () => {
  const s = setup();
  const { car, ref } = await book(s, { car: "escalade", from: "2027-04-01", to: "2027-04-20" });   // 19 days > 7-day hold
  let b = await s.repo.get(car, ref);
  s.setTime(placeAt(b)); await s.deposits.sweep();
  b = await s.repo.get(car, ref); const first = b.deposit.paymentIntentId; assert.equal(b.deposit.amount, 75000);
  s.setTime(Date.parse(b.deposit.captureBefore) - 6 * H); await s.deposits.sweep();
  b = await s.repo.get(car, ref);
  assert.equal(b.deposit.status, "held"); assert.notEqual(b.deposit.paymentIntentId, first, "renewed");
  assert.ok(s.stripe.calls.piCancel.includes(first), "old hold cancelled");
  s.setTime(releaseAt(b)); await s.deposits.sweep();
  b = await s.repo.get(car, ref); assert.equal(b.deposit.status, "released"); assert.equal(b.deposit.releaseReason, "auto after return");

  const s2 = setup();
  s2.stripe.fake.declineHolds = true;
  const x = await book(s2, { car: "srx", from: "2026-10-13", to: "2026-10-14" });
  const f = (await s2.repo.get(x.car, x.ref)).deposit;
  assert.equal(f.status, "failed"); assert.match(f.error, /declined/);
  assert.match(s2.notices.at(-1).subject, /Deposit hold failed/);
  s2.stripe.fake.declineHolds = false;
  assert.equal((await j(await admin(s2, { car: x.car, id: x.ref, action: "place" }))).data.deposit.status, "held");
});

test("hosted Stripe page fallback also saves the card and gets a deposit hold", async () => {
  const s = setup({ hosted: true });
  const r = await j(await s.checkout(post("/api/checkout", trip({ car: "van", from: "2026-10-13", to: "2026-10-16" }))));
  const p = s.stripe.calls.create[0].params;
  assert.equal(p.customer_creation, "always"); assert.equal(p.payment_intent_data.setup_future_usage, "off_session");
  assert.match(p.custom_text.submit.message, /\$250 security deposit hold/);
  const sess = s.stripe.pay(r.data.url.split("/").pop());
  await s.hook(signedEvent("checkout.session.completed", sess));
  const b = (await s.repo.all("van")).find(x => x.from === "2026-10-13");
  assert.equal(b.status, "confirmed"); assert.equal(b.deposit.status, "held"); assert.equal(b.deposit.amount, 25000);
});
