// HTTP handlers. Each takes its dependencies so tests can run them with a fake
// Stripe and a local store. The files in netlify/functions wire in the real ones.
import { randomUUID } from "node:crypto";
import { CARS, LOCATIONS, placeText, TAX, CHECKOUT_MINUTES, DEPOSITS, SMOKING_FEE, DEPOSIT_LEAD_HOURS, DEPOSIT_RELEASE_HOURS, MIN_AGE } from "./catalog.mjs";
import { validateRequest, quote, niceDate, daysBetween, BookingError } from "./pricing.mjs";
import { makeRepo, spans } from "./bookings.mjs";
import { AGREEMENT_VERSION, agreementPage, clickwrapText, agreementText, agreementFingerprint, CLICKWRAP_LINKS } from "./agreement.mjs";
import { makeDeposits, depositCents, placeAt } from "./deposits.mjs";
import { makeIdentity, idDueAt } from "./identity.mjs";
import { confirmationEmail, ownerBookingEmail } from "./email.mjs";

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
      await Promise.all(Object.keys(CARS).map(async c => { cars[c] = (await repo.active(c)).flatMap(b => spans(b).map(r => ({ from: r.from, to: r.to }))); }));
      const prices = Object.fromEntries(Object.entries(CARS).map(([k, c]) => [k, { weekday: c.weekday, weekend: c.weekend, deposit: DEPOSITS[k] || 0 }]));
      return json({ cars, prices });
    } catch (e) { return fail(e); }
  };
}

/** POST /api/checkout {car, from, to, fromTime, toTime, location}
 *  On-site payment (publishableKey set): holds the dates, creates a Stripe PaymentIntent and
 *  returns { checkout: "/checkout.html?car=..&ref=.." }. Otherwise falls back to Stripe's hosted page: { url }. */
export function checkoutHandler({ store, stripe, siteUrl, now = () => Date.now(), id = randomUUID, requireTerms = false, publishableKey = "",
  userOf = null, requireAccount = false, linkBooking = null, creditsFor = null }) {
  const repo = makeRepo(store, { now });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    let held = null, r = null;
    try {
      // Like Turo: renters sign in (Google or email) before booking
      const user = userOf ? await userOf(req) : null;
      if (requireAccount && !user) return json({ error: "login_required", message: "Log in or sign up to book this car." }, 401);
      r = validateRequest(await readJSON(req), new Date(now()));
      const q = quote({ ...r, credits: user && creditsFor ? creditsFor(user) : [] });   // referral discount / Ace Fares credit
      held = await repo.hold(r.car, r, id());
      if (user) {
        await repo.note(r.car, held.id, { userId: user.id, accountName: `${user.firstName || ""} ${user.lastName || ""}`.trim(), accountEmail: user.email,
          ...(q.credits.length ? { credits: q.credits } : {}) });
        if (linkBooking) { try { await linkBooking(user.id, r.car, held.id); } catch (e) { console.error("[booking] could not add trip to account", e && e.message); } }
      }
      const car = CARS[r.car], loc = LOCATIONS[r.location];
      const dates = `${niceDate(r.from)} to ${niceDate(r.to)}`;
      const meta = { booking_id: held.id, car: r.car, from: r.from, to: r.to, from_time: r.fromTime, to_time: r.toTime, location: r.location,
        deposit_hold_amount: (DEPOSITS[r.car] || 0).toFixed(2), ...(user ? { user_id: user.id } : {}),
        ...(q.credit ? { credit_applied: (q.credit / 100).toFixed(2), credit_codes: q.credits.map(c => c.code).join(",") } : {}) };
      if (publishableKey) {
        const pi = await stripe.paymentIntents.create({
          amount: q.total, currency: "usd",
          automatic_payment_methods: { enabled: true },      // methods come from the Stripe Dashboard (card, Google Pay, Apple Pay, ...)
          setup_future_usage: "off_session",                 // save the card for the security deposit hold (agreement section 5)
          description: `${car.name}, ${dates}, ${loc.name}`,
          metadata: meta,
        }, { idempotencyKey: `pi-${held.id}` });
        await repo.attachPayment(r.car, held.id, pi.id, q.total);
        return json({ checkout: `/checkout.html?car=${r.car}&ref=${held.id}`, ref: held.id, total: q.total });
      }
      const line = (name, cents, description) => ({ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name, ...(description ? { description } : {}) } } });
      const items = [line(`${car.name} rental`, q.rental - q.discount - q.credit,
        `${dates} (${q.days} day${q.days > 1 ? "s" : ""}: ${[q.weekdays ? `${q.weekdays} Mon-Thu at $${q.weekdayRate}` : "", q.weekends ? `${q.weekends} Fri-Sun at $${q.weekendRate}` : ""].filter(Boolean).join(", ")}), ${car.miles * q.days} miles included${q.discount ? `. ${q.discountLabel} applied` : ""}${q.credit ? `. ${q.credits.map(c => `${c.label} -$${(c.amount / 100).toFixed(2)}`).join(", ")}` : ""}`)];
      if (q.fee) items.push(line(loc.name, q.fee));
      items.push(line(`${TAX.label} (${q.taxPct}%)`, q.tax));
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        // payment methods come from the Stripe Dashboard settings (cards, Apple Pay, Google Pay, etc.)
        line_items: items,
        billing_address_collection: "required",
        phone_number_collection: { enabled: true },
        metadata: meta,
        ...(requireTerms ? {
          // "I agree" box on Stripe's page. Needs a terms URL saved at dashboard.stripe.com/settings/public
          consent_collection: { terms_of_service: "required" },
        } : {}),
        customer_creation: "always",
        payment_intent_data: { metadata: meta, description: `${car.name}, ${dates}, ${loc.name}`, setup_future_usage: "off_session" },
        custom_text: { ...(requireTerms ? { terms_of_service_acceptance: { message: `I have read and agree to the [Ace Fares Rental Agreement](${siteUrl}/rental-agreement).` } } : {}),
          submit: { message: `Your card is saved for a refundable $${DEPOSITS[r.car] || 0} security deposit hold (not a charge), placed before pickup and released after return. No smoking or vaping: $${SMOKING_FEE} fee.` } },
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
      if (b && (b.status === "hold" || b.status === "expired")) {
        if (b.sessionId) { try { await stripe.checkout.sessions.expire(b.sessionId); } catch (e) { /* already expired or completed */ } }
        if (b.paymentIntentId) { try { await stripe.paymentIntents.cancel(b.paymentIntentId); } catch (e) { /* already paid or cancelled */ } }
        await repo.release(car, ref);
      }
      return json({ ok: true });
    } catch (e) { return fail(e); }
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

const usd = c => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The visitor's IP as seen by Netlify (the browser can't be trusted to report its own). */
export function clientIp(req, ctx) {
  const v = (ctx && ctx.ip) || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0];
  return clean(v, 64) || "unknown";
}

/** Signature record as Stripe metadata (string values up to 500 characters). */
export function stripeLedger(sig) {
  return {
    contract_signed: "true", contract_method: "clickwrap_checkbox", contract_signed_at: sig.signedAt,
    contract_client_time: sig.clientTime || "", contract_version: sig.agreementVersion, contract_sha256: sig.sha256,
    signer_ip: sig.ip, signer_user_agent: sig.userAgent.slice(0, 500),
    deposit_policy_ack: "true", deposit_hold_amount: (sig.depositAmount / 100).toFixed(2),
    smoking_policy_ack: "true", smoking_fee: (sig.smokingFee / 100).toFixed(2),
  };
}

/** What the checkout page shows next to the signature box. */
function termsInfo(car, b, now) {
  const soon = now() >= placeAt(b);
  return { version: AGREEMENT_VERSION, deposit: DEPOSITS[car] || 0, smokingFee: SMOKING_FEE, releaseHours: DEPOSIT_RELEASE_HOURS,
    depositTiming: soon ? "right after you pay" : `about ${DEPOSIT_LEAD_HOURS} hours before pickup`,
    clickwrap: clickwrapText({ total: usd(b.total), deposit: DEPOSITS[car] }), clickwrapLinks: CLICKWRAP_LINKS };
}

function summaryOf(car, b) {
  const c = CARS[car], q = quote({ car, location: b.location, days: daysBetween(b.from, b.to), from: b.from, credits: b.credits || [] });
  return {
    car, carName: c.name, photo: c.photo, rating: c.rating, trips: c.trips, miles: c.miles * q.days,
    from: b.from, to: b.to, fromTime: b.fromTime, toTime: b.toTime, location: placeText(b.location), locationId: b.location,
    days: q.days, weekdays: q.weekdays, weekends: q.weekends, weekdayRate: q.weekdayRate, weekendRate: q.weekendRate,
    rental: q.rental, discount: q.discount, discountLabel: q.discountLabel, credits: q.credits, fee: q.fee, taxPct: q.taxPct, tax: q.tax, total: q.total,
  };
}

/** GET /api/checkout-details?car=&ref=  -> trip summary + what the checkout page needs to show the payment form
 *  POST /api/checkout-details {car, ref, name, email, phone, agree} -> saves the renter, refreshes the hold */
export function checkoutDetailsHandler({ store, stripe, publishableKey, now = () => Date.now(), userOf = null, roamlyUrl = "", accounts = null }) {
  const repo = makeRepo(store, { now });
  // A trip booked while signed in can only be paid for from that account
  const notYours = async (req, b) => {
    if (!b || !b.userId || !userOf) return null;
    const u = await userOf(req);
    if (!u) return json({ error: "login_required", message: "Please log in to finish booking this trip." }, 401);
    return u.id === b.userId ? null : json({ error: "not_found", message: "This checkout belongs to a different account. Log in with the account you booked with." }, 404);
  };
  return async (req, ctx) => {
    try {
      if (req.method === "GET") {
        const u = new URL(req.url), car = u.searchParams.get("car"), ref = u.searchParams.get("ref") || "";
        if (!CARS[car] || !/^[0-9a-f-]{36}$/.test(ref)) return json({ error: "not_found", message: "This checkout link isn't valid." }, 404);
        const b = await repo.get(car, ref);
        if (!b || !b.paymentIntentId) return json({ error: "not_found", message: "This checkout link isn't valid." }, 404);
        // Anyone with this private checkout link can finish paying; logging in is never required
        const out = { status: b.status, expiresAt: b.expiresAt, summary: summaryOf(car, b), terms: termsInfo(car, b, now), insurance: { roamlyUrl: roamlyUrl || "" } };
        const me = userOf ? await userOf(req) : null;
        if (me) out.prefill = { name: `${me.firstName || ""} ${me.lastName || ""}`.trim(), email: me.email, phone: me.phone || "" };
        out.signedIn = !!me;
        if (b.status === "confirmed" || b.status === "conflict") out.paymentIntent = b.paymentIntentId;
        if (b.status === "hold" || b.status === "expired") {
          const pi = await stripe.paymentIntents.retrieve(b.paymentIntentId);
          if (pi.status === "succeeded" || pi.status === "processing") out.paymentIntent = pi.id;   // already paid: page shows the result
          else if (pi.status === "canceled") out.status = "released";
          else { out.clientSecret = pi.client_secret; out.publishableKey = publishableKey; }
        }
        return json(out);
      }
      if (req.method !== "POST") return json({ error: "method" }, 405);
      const body = await readJSON(req);
      const car = body.car, ref = typeof body.ref === "string" ? body.ref : "";
      if (!CARS[car] || !/^[0-9a-f-]{36}$/.test(ref)) throw new BookingError("bad_request", "This checkout link isn't valid.");
      const name = clean(body.name, 120), email = clean(body.email, 200).toLowerCase(), phone = clean(body.phone, 40);
      if (name.length < 2) throw new BookingError("bad_name", "Enter your full name as it appears on your driver's license.");
      if (!EMAIL_RE.test(email)) throw new BookingError("bad_email", "Enter a valid email address.");
      if (phone.replace(/\D/g, "").length < 8) throw new BookingError("bad_phone", "Enter a mobile phone number we can text.");
      // Age (checkout asks "Select your age"); older clients may not send it
      const age = body.age === undefined ? null : String(body.age);
      if (age !== null && !/^(2[1-4]|25\+)$/.test(age)) throw new BookingError(age === "under21" ? "too_young" : "bad_age", age === "under21" ? `Drivers must be at least ${MIN_AGE} to book.` : "Select your age.");
      // Insurance: the renter's own policy, or Roamly (only offered once ROAMLY_URL is set)
      const ins = body.insurance && typeof body.insurance === "object" ? body.insurance : {};
      const insurance = ins.choice === "roamly" && roamlyUrl ? { choice: "roamly" }
        : { choice: "own", company: clean(ins.company, 80), policy: clean(ins.policy, 60) };
      if (ins.protection === true) insurance.protection = "requested";   // optional Wheelbase damage protection: owner sends price/terms before pickup
      if (insurance.choice === "own" && insurance.company.length < 2) throw new BookingError("insurance_required", "Enter the name of your auto insurance company.");
      if (body.agree !== true) throw new BookingError("agree_required", "Please check the box to sign the rental agreement.");
      if (body.termsVersion !== AGREEMENT_VERSION) throw new BookingError("terms_changed", "Our rental agreement was just updated. Refresh this page to review the latest version, then sign again.", 409);
      const before = await repo.get(car, ref);
      // Where to meet: a delivery needs the address; an airport handoff can include the flight
      const handoff = {};
      if (before && before.location === "dallas-delivery") {
        const addr = clean(body.deliveryAddress, 200);
        if (addr.length < 8) throw new BookingError("address_required", "Enter the address where we should deliver the car.");
        handoff.address = addr;
      }
      if (before && before.location === "dfw" && clean(body.flight, 40)) handoff.flight = clean(body.flight, 40);

      const b = await repo.renew(car, ref);
      // Clickwrap signature record. Time and IP come from our server, not the browser, so they can't be faked.
      const signedAt = new Date(now()).toISOString();
      const clientTime = typeof body.agreedAt === "string" && Math.abs(Date.parse(body.agreedAt) - now()) < 864e5 ? new Date(Date.parse(body.agreedAt)).toISOString() : null;
      const signed = { ...b, car, customer: { name, email, phone } };
      const words = clickwrapText({ total: usd(b.total), deposit: DEPOSITS[car] });
      const signature = {
        signed: true, method: "clickwrap checkbox", signedAt, clientTime, ip: clientIp(req, ctx),
        userAgent: clean(req.headers.get("user-agent"), 300), agreementVersion: AGREEMENT_VERSION,
        sha256: agreementFingerprint(signed, words), clickwrap: words,
        depositAck: true, depositAmount: depositCents(car), smokingAck: true, smokingFee: SMOKING_FEE * 100,
      };
      await repo.note(car, ref, { customer: { name, email, phone, ...(age ? { age } : {}) }, insurance: { ...insurance, at: signedAt }, ...(Object.keys(handoff).length ? { handoff } : {}), termsAccepted: true, termsAcceptedAt: signedAt, agreementVersion: AGREEMENT_VERSION, signature });
      // Full signed copy (the exact words they agreed to), kept separately from the booking list
      if (store.setJSON) await store.setJSON(`signed-agreement-${ref}`, { ...signature, car, bookingId: ref, renter: { name, email, phone }, text: agreementText(signed) });
      // Customer for the saved card (deposit hold), and the signature ledger on the payment itself
      let customerId = b.customerId;
      const cust = { name, email, phone, metadata: { last_booking_id: ref } };
      if (customerId) await stripe.customers.update(customerId, cust);
      else { customerId = (await stripe.customers.create(cust)).id; await repo.note(car, ref, { customerId }); }
      await stripe.paymentIntents.update(b.paymentIntentId, { customer: customerId, receipt_email: email, metadata: {
        renter_name: name, renter_phone: phone, ...stripeLedger(signature),
        ...(handoff.address ? { delivery_address: handoff.address } : {}), ...(handoff.flight ? { flight: handoff.flight } : {}),
        insurance_choice: insurance.choice, ...(insurance.protection ? { damage_protection: "wheelbase_requested" } : {}), ...(insurance.choice === "own" ? { insurance_company: insurance.company, insurance_policy: insurance.policy } : {}) } });
      // No login needed to book: put the trip on an account (the signed-in one, or one found/created from these details)
      let account = null, setCookie = null;
      if (accounts && before && !before.userId) {
        try {
          const me = userOf ? await userOf(req) : null;
          const r = me ? { user: me, created: false, setCookie: null, signedIn: true } : await accounts.accountForCheckout(req, { name, email, phone });
          if (r && r.user) {
            await repo.note(car, ref, { userId: r.user.id, accountName: `${r.user.firstName || ""} ${r.user.lastName || ""}`.trim(), accountEmail: r.user.email, ...(r.created ? { accountCreatedAtCheckout: true } : {}) });
            await accounts.linkBooking(r.user.id, car, ref);
            account = r.signedIn ? "signed_in" : r.created ? "created" : "existing"; setCookie = r.setCookie;
          }
        } catch (e) { console.error("[booking] could not attach an account", e && e.message); }
      }
      return json({ ok: true, expiresAt: b.expiresAt, signedAt, sha256: signature.sha256, ...(account ? { account } : {}) }, 200, setCookie ? { "set-cookie": setCookie } : {});
    } catch (e) {
      if (e && e.type && String(e.type).startsWith("Stripe")) {
        console.error("[booking] Stripe error", e.type, e.message);
        return json({ error: "payment_unavailable", message: "Online payment isn't available right now. Please try again in a few minutes, or text us to book." }, 502);
      }
      return fail(e);
    }
  };
}

/** GET /api/booking?session_id=cs_... or ?payment_intent=pi_... -> booking status for the confirmation screen */
export function bookingStatusHandler({ store, stripe, now, mailer = null, siteUrl = "", notify = null, referrals = null, accounts = null }) {
  const repo = makeRepo(store, { now });
  const deposits = makeDeposits({ store, stripe, now, notify });
  return async (req) => {
    try {
      const params = new URL(req.url).searchParams;
      const piId = params.get("payment_intent") || "";
      if (piId) {
        if (!/^pi_[A-Za-z0-9_]+$/.test(piId)) return json({ error: "bad_request" }, 400);
        const pi = await stripe.paymentIntents.retrieve(piId);
        const m = pi.metadata || {};
        if (!CARS[m.car] || m.kind) return json({ error: "not_found" }, 404);   // deposits, extensions and charges aren't trips
        let b = await repo.get(m.car, m.booking_id);
        if (b && pi.status === "succeeded" && b.status !== "confirmed" && b.status !== "conflict" && b.status !== "cancelled") {
          const changed = await repo.confirm(m.car, b.id, { paymentIntent: pi.id, amountPaid: pi.amount_received || pi.amount });
          await afterConfirm(repo, m.car, changed, { mailer, siteUrl, deposits, referrals, accounts });
          b = changed || (await repo.get(m.car, b.id));
        }
        const status = !b ? "unknown" : (b.status === "confirmed" || b.status === "conflict" || b.status === "cancelled") ? b.status
          : pi.status === "processing" ? "processing" : pi.status === "requires_payment_method" ? "failed" : b.status;
        return json({
          status, paid: pi.status === "succeeded", car: CARS[m.car].name, carId: m.car, ref: m.booking_id,
          from: m.from, to: m.to, fromTime: m.from_time, toTime: m.to_time,
          location: LOCATIONS[m.location] ? LOCATIONS[m.location].name : "", total: pi.amount, email: b && b.customer && b.customer.email,
          verification: (b && b.verification && b.verification.status) || "not_started", idDueAt: idDueAt(b),
        });
      }
      const sid = params.get("session_id") || "";
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ error: "bad_request" }, 400);
      const s = await stripe.checkout.sessions.retrieve(sid);
      const m = s.metadata || {};
      if (!CARS[m.car]) return json({ error: "not_found" }, 404);
      let b = await repo.get(m.car, m.booking_id);
      // the webhook may not have arrived yet; if Stripe says it's paid, confirm now (idempotent)
      if (b && s.payment_status === "paid" && b.status !== "confirmed" && b.status !== "conflict") {
        const changed = await repo.confirm(m.car, b.id, customerOf(s));
        await afterConfirm(repo, m.car, changed, { mailer, siteUrl, deposits, referrals, accounts });
        b = changed || (await repo.get(m.car, b.id));
      }
      return json({
        status: b ? b.status : "unknown", paid: s.payment_status === "paid",
        car: CARS[m.car].name, from: m.from, to: m.to, fromTime: m.from_time, toTime: m.to_time,
        location: LOCATIONS[m.location] ? LOCATIONS[m.location].name : "", total: s.amount_total, email: s.customer_details && s.customer_details.email,
        carId: m.car, ref: m.booking_id, verification: (b && b.verification && b.verification.status) || "not_started",
      });
    } catch (e) {
      if (e && e.type && String(e.type).startsWith("Stripe")) return json({ error: "not_found" }, 404);
      return fail(e);
    }
  };
}

const customerOf = s => ({ customer: {
  name: s.customer_details && s.customer_details.name, email: s.customer_details && s.customer_details.email,
  phone: s.customer_details && s.customer_details.phone }, paymentIntent: s.payment_intent, amountPaid: s.amount_total, customerId: s.customer || undefined,
  termsAccepted: !!(s.consent && s.consent.terms_of_service === "accepted"), agreementVersion: AGREEMENT_VERSION });

// After a booking becomes confirmed (only once), email the renter their confirmation and agreement.
async function afterConfirm(repo, car, b, { mailer, siteUrl, deposits, referrals = null, accounts = null }) {
  if (!b || b.status !== "confirmed") return;
  // paid on Stripe's hosted page without an account: find or create one from the details Stripe collected
  if (accounts && !b.userId && b.customer && b.customer.email) {
    try {
      const r = await accounts.accountForCheckout(null, b.customer);
      if (r && r.user) {
        const fields = { userId: r.user.id, accountName: `${r.user.firstName || ""} ${r.user.lastName || ""}`.trim(), accountEmail: r.user.email, ...(r.created ? { accountCreatedAtCheckout: true } : {}) };
        await repo.note(car, b.id, fields); await accounts.linkBooking(r.user.id, car, b.id); b = { ...b, ...fields };
      }
    } catch (e) { console.error("[booking] could not attach an account", e && e.message); }
  }
  if (referrals) { try { await referrals.onConfirmed(car, b); } catch (e) { console.error("[referral] could not use credit", e && e.message); } }
  if (deposits) {
    try { const d = await deposits.onConfirmed(car, b); if (d) b = { ...b, deposit: d }; }
    catch (e) { console.error("[deposit] could not set up the deposit hold", e && e.message); }
  }
  if (!mailer) return;
  // tell the business about every new booking
  if (mailer.ownerEmail && !b.ownerEmailedAt) {
    try {
      await mailer.send({ to: mailer.ownerEmail, ...ownerBookingEmail(car, b, siteUrl) });
      await repo.note(car, b.id, { ownerEmailedAt: new Date().toISOString() });
    } catch (e) { console.error("[booking] owner alert email failed", e && e.message); }
  }
  const to = b.customer && b.customer.email;
  if (!to) return;
  try {
    await mailer.send({ to, ...confirmationEmail(car, b, siteUrl) });
    await repo.note(car, b.id, { emailedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[booking] confirmation email failed", e && e.message);
    await repo.note(car, b.id, { emailError: String(e && e.message || e).slice(0, 200) }).catch(() => {});
  }
}

/** POST /api/stripe-webhook — Stripe tells us when checkout is paid or expires */
export function webhookHandler({ store, stripe, webhookSecret, now, mailer = null, siteUrl = "", notify = null, referrals = null, accounts = null }) {
  const repo = makeRepo(store, { now });
  const deposits = makeDeposits({ store, stripe, now, notify });
  const identity = makeIdentity({ store, stripe, now, notify });
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
      if (event.type.startsWith("identity.")) { await identity.onEvent(event); return json({ received: true, identity: true }); }   // license + selfie check
      if (m.kind === "deposit") { await deposits.onEvent(event); return json({ received: true, deposit: true }); }   // never treat a deposit hold as a rental payment
      if (m.kind === "charge_link") {   // a post-trip charge paid with the emailed link (lib/pay.mjs)
        if (event.type === "checkout.session.completed" && s.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded") {
          const { markLinkPaid } = await import("./pay.mjs");
          await markLinkPaid(store, { car: m.car, bookingId: m.booking_id, chargeId: m.charge_id, sessionId: s.id, paymentIntent: s.payment_intent, amount: s.amount_total, now, notify });
        }
        return json({ received: true, charge: true });
      }
      if (m.kind) return json({ received: true, ignored: true });   // extension and post-trip charges are recorded when they are made (lib/trips.mjs)
      if (event.type.startsWith("payment_intent.")) {
        if (event.type === "payment_intent.succeeded") {
          const b = await repo.confirm(m.car, m.booking_id, { paymentIntent: s.id, amountPaid: s.amount_received || s.amount });
          await afterConfirm(repo, m.car, b, { mailer, siteUrl, deposits, referrals, accounts });
          if (b && b.status === "conflict") console.error(`[booking] PAID BUT DATES TAKEN: refund needed for ${m.car} ${m.from}-${m.to}, payment ${s.id}`);
        } else if (event.type === "payment_intent.processing") {
          await repo.extendHold(m.car, m.booking_id, 7 * 24 * 60);           // e.g. bank payment: keep the dates while it clears
        } else if (event.type === "payment_intent.payment_failed") {
          const b = await repo.get(m.car, m.booking_id);
          if (b && b.pendingPayment) await repo.release(m.car, m.booking_id);  // a delayed payment failed; a declined card can simply retry
        } else if (event.type === "payment_intent.canceled") {
          await repo.release(m.car, m.booking_id);
        }
        return json({ received: true });
      }
      const paidNow = (event.type === "checkout.session.completed" && s.payment_status === "paid")
        || event.type === "checkout.session.async_payment_succeeded";      // e.g. bank payments that clear later
      if (paidNow) {
        const b = await repo.confirm(m.car, m.booking_id, customerOf(s));
        await afterConfirm(repo, m.car, b, { mailer, siteUrl, deposits, referrals, accounts });
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
/** POST /api/admin/reset {confirm: "RESET"} -> empties every car's calendar. Nothing is deleted: each car's
 *  bookings are copied to archive-<time>-car-<id> first. Deposit holds still on cards are released. */
export function adminResetHandler({ store, stripe = null, adminKey, now = () => Date.now() }) {
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (!keyOk(req, adminKey)) return json({ error: "unauthorized" }, 401);
    try {
      const body = await readJSON(req);
      if (body.confirm !== "RESET") return json({ error: "confirm_required", message: "Type RESET to confirm." }, 400);
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-"), out = { archived: 0, released: 0, archive: `archive-${stamp}` };
      for (const car of Object.keys(CARS)) {
        const cur = await store.getWithMetadata(`car-${car}`, { type: "json" });
        const list = (cur && cur.data && cur.data.bookings) || [];
        if (!list.length) continue;
        await store.setJSON(`archive-${stamp}-car-${car}`, { archivedAt: new Date(now()).toISOString(), bookings: list });
        for (const b of list) {
          if (stripe && b.deposit && b.deposit.status === "held" && b.deposit.paymentIntentId) {
            try { await stripe.paymentIntents.cancel(b.deposit.paymentIntentId); out.released++; } catch (e) { console.warn("[reset] deposit release", e && e.message); }
          }
          if (stripe && b.status === "hold" && b.paymentIntentId) { try { await stripe.paymentIntents.cancel(b.paymentIntentId); } catch {} }
        }
        await store.setJSON(`car-${car}`, { bookings: [] });
        out.archived += list.length;
      }
      return json({ ok: true, ...out });
    } catch (e) { return fail(e); }
  };
}

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
    // page settings, reviews (including hidden ones) and the post-trip charge menu
    const { getSettings, chargeTypesForPage } = await import("./trips.mjs");
    out._settings = await getSettings(store);
    out._reviews = (((await store.getWithMetadata("reviews", { type: "json" })) || {}).data || {}).list || [];
    out._chargeTypes = chargeTypesForPage();
    return json(out);
  };
}

/** POST /api/admin/deposit {car, id, action: "release"|"capture"|"keep"|"unkeep"|"place", amount (dollars), note} */
export function adminDepositHandler({ store, stripe, adminKey, now, notify = null }) {
  const deposits = makeDeposits({ store, stripe, now, notify });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (!keyOk(req, adminKey)) return json({ error: "unauthorized" }, 401);
    try {
      const { car, id, action, amount, note } = await readJSON(req);
      if (!CARS[car] || typeof id !== "string") return json({ error: "bad_request" }, 400);
      const b = await deposits.repo.get(car, id);
      if (!b) return json({ error: "not_found" }, 404);
      let d;
      if (action === "release") d = await deposits.release(car, b, "released by owner");
      else if (action === "capture") d = await deposits.capture(car, b, Math.round(Number(amount) * 100), clean(note, 400));
      else if (action === "keep" || action === "unkeep") d = (await deposits.repo.note(car, id, { deposit: { ...(b.deposit || {}), keep: action === "keep" } })).deposit;
      else if (action === "place") {
        if (b.status !== "confirmed") return json({ error: "bad_request", message: "Only paid bookings can have a deposit hold." }, 400);
        if (b.deposit && b.deposit.status === "held") return json({ error: "bad_request", message: "A hold is already in place." }, 400);
        d = await deposits.place(car, b);
      } else return json({ error: "bad_request" }, 400);
      return json({ ok: true, deposit: d });
    } catch (e) {
      if (e && (e.code === "no_hold" || e.code === "bad_amount")) return json({ error: e.code, message: e.message }, 400);
      if (e && e.type && String(e.type).startsWith("Stripe")) return json({ error: "stripe", message: e.message }, 502);
      return fail(e);
    }
  };
}

/** GET /rental-agreement — the agreement as a web page */
export function agreementPageHandler() {
  return async () => new Response(agreementPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff", "x-frame-options": "SAMEORIGIN", "referrer-policy": "strict-origin-when-cross-origin" } });
}
