// After booking: renters cancel or ask to extend from My trips; the owner approves extensions and
// charges post-trip fees (late return, fuel, cleaning, extra miles, tolls, tickets) from the bookings page.
//
// Cancellation (rental agreement section 15): before the pickup time only. Full refund within 24 hours
//   after booking; after that the refund is the amount paid minus the cancellation fee. Any deposit hold is
//   released and Ace Fares credit used on the trip is given back.
// Extensions (section 10): the renter picks a later return date; the extra days stay reserved for them while
//   the owner decides. Approving charges the saved card: each extra day's normal rate + the extension fee, plus tax.
//   The owner can turn extension requests off for everyone on the bookings page.
// Post-trip charges (sections 4, 8-12, 14): priced from the rental agreement's POLICY, charged to the card saved
//   at checkout (or collected from the deposit hold), and the renter is emailed an itemized statement.
import { randomBytes } from "node:crypto";
import { CARS, TAX, MAX_DAYS, SMOKING_FEE, EXTENSION_DAILY_FEE, LOCATIONS } from "./catalog.mjs";
import { POLICY, BUSINESS, extraMileList } from "./agreement.mjs";
import { makeRepo, clashes, isActive } from "./bookings.mjs";
import { dayRates, daysBetween, isValidDate, niceDate, BookingError, validateRequest, quote } from "./pricing.mjs";
import { makeDeposits, localMs } from "./deposits.mjs";
import { getJSON, updateJSON } from "./kv.mjs";

const H = 3600e3;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const iso = ms => new Date(ms).toISOString();
const isStripe = e => e && e.type && String(e.type).startsWith("Stripe");
const idOf = x => (x && typeof x === "object" ? x.id : x) || null;
const coded = (code, message, status = 400) => new BookingError(code, message, status);
export const usd = c => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t12 = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const firstName = b => ((b.customer && b.customer.name) || b.accountName || "").split(" ")[0] || "there";
const renterEmail = b => (b.customer && b.customer.email) || b.accountEmail || "";

async function readBody(req, max = 4096) {
  const text = await req.text();
  if (text.length > max) throw coded("bad_request", "Request too large.");
  try { const v = JSON.parse(text || "{}"); return v && typeof v === "object" ? v : {}; } catch { throw coded("bad_request", "Something went wrong with that request. Please try again."); }
}
const sameOrigin = req => { const o = req.headers.get("origin"); try { return !o || new URL(o).host === new URL(req.url).host; } catch { return false; } };
const keyOk = (req, adminKey) => {
  const got = req.headers.get("x-admin-key") || "";
  if (!adminKey || got.length !== adminKey.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ adminKey.charCodeAt(i);
  return diff === 0;
};

/* ---------- settings (bookings page switches) ---------- */

const SETTINGS_KEY = "config-settings";
export const DEFAULT_SETTINGS = { extensionsAllowed: true };
export async function getSettings(store) { return { ...DEFAULT_SETTINGS, ...((await getJSON(store, SETTINGS_KEY)) || {}) }; }
export async function saveSettings(store, fields) {
  const clean = {};
  if (typeof fields.extensionsAllowed === "boolean") clean.extensionsAllowed = fields.extensionsAllowed;
  return updateJSON(store, SETTINGS_KEY, cur => ({ ...DEFAULT_SETTINGS, ...(cur || {}), ...clean }));
}

/* ---------- emails ---------- */

export function simpleEmail(title, paras, rows = [], foot = "") {
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#15130F;max-width:600px;margin:0 auto">
  <div style="background:#0F1A34;color:#F4EFE4;padding:14px 18px;border-radius:12px 12px 0 0"><strong style="color:#DAA336">Ace Fares</strong> Rental Company</div>
  <div style="background:#FBF8F1;padding:20px 18px;border:1px solid #E4DCCB;border-top:0;border-radius:0 0 12px 12px">
  <h2 style="margin:0 0 10px;font-family:Georgia,serif;font-weight:400">${esc(title)}</h2>
  ${paras.map(p => `<p style="margin:0 0 12px">${p.html || esc(p)}</p>`).join("")}
  ${rows.length ? `<table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #E4DCCB">${rows.map(([k, v, bold]) => `<tr><td style="padding:8px 12px;border-top:1px solid #E4DCCB;${bold ? "font-weight:700" : "color:#514A3D"}">${esc(k)}</td><td style="padding:8px 12px;border-top:1px solid #E4DCCB;text-align:right;${bold ? "font-weight:700" : ""}">${esc(v)}</td></tr>`).join("")}</table>` : ""}
  <p style="margin:14px 0 0;color:#6F6757;font-size:14px">${foot ? esc(foot) + " " : ""}Questions? Text or call ${esc(BUSINESS.phone)} or reply to this email.</p></div></div>`;
  const text = `${title}\n\n${paras.map(p => (p.text || p)).join("\n\n")}\n${rows.length ? "\n" + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" : ""}\n${foot ? foot + " " : ""}Questions? Text or call ${BUSINESS.phone} or reply to this email.\n`;
  return { html, text };
}
const tripLine = (car, b) => `${CARS[car].name}, ${niceDate(b.from)} to ${niceDate(b.to)}`;

/* ---------- cancellation ---------- */

/** What happens if the renter cancels now. Amounts in cents. */
/** Extra payments on a trip besides the rental itself (extensions, date-change differences), each refundable on its own. */
export const extraPayments = b => [...(b.extensions || []), ...(b.adjustments || [])].filter(e => e.paymentIntentId && e.amount > 0);
/** The refund under the cancellation policy, ignoring whether the trip has started. Amounts in cents. */
export function policyTerms(b, t) {
  const paid = b.amountPaid || b.total || 0;
  const freeUntil = Date.parse(b.confirmedAt || b.createdAt) + 24 * H;
  const free = t <= freeUntil;
  const fee = free ? 0 : Math.min(paid, POLICY.cancellationFee * 100);
  const extensionRefund = extraPayments(b).reduce((a, e) => a + e.amount, 0);
  return { allowed: true, free, freeUntil: iso(freeUntil), paid, fee, refund: paid - fee, extensionRefund, totalRefund: paid - fee + extensionRefund };
}
export function cancelTerms(b, t) {
  if (!b || b.status !== "confirmed") return { allowed: false, reason: "Only booked trips can be cancelled." };
  if (t >= localMs(b.from, b.fromTime)) return { allowed: false, reason: `Your trip has already started, so it can't be cancelled online. Text us at ${BUSINESS.phone} if you need to end it early.` };
  return policyTerms(b, t);
}

/* ---------- extensions ---------- */

const isPending = x => !!x && (x.status === "requested" || x.status === "payment_failed");
const pendingExt = b => isPending(b.extension);
const pendingChange = b => isPending(b.change);

/** Price of extending the return date to newTo. Amounts in cents. */
export function extensionQuote(car, b, newTo) {
  if (!isValidDate(newTo)) throw coded("bad_dates", "Choose your new return date.");
  const days = daysBetween(b.to, newTo);
  if (days < 1) throw coded("bad_range", "Choose a return date after your current one.");
  const total = daysBetween(b.from, newTo);
  if (total > MAX_DAYS) throw coded("too_long", `Trips can be up to ${MAX_DAYS} days. Text us for longer rentals.`);
  const dr = dayRates(car, b.to, days);           // the extra days are b.to .. newTo-1, priced by weekday
  const rental = dr.subtotal * 100, fee = days * EXTENSION_DAILY_FEE * 100;
  const taxPct = total <= TAX.shortMaxDays ? TAX.shortPct : TAX.longPct;
  const tax = Math.round((rental + fee) * taxPct / 100);
  return { to: newTo, toTime: b.toTime, days, weekdays: dr.weekdays, weekends: dr.weekends, weekdayRate: CARS[car].weekday, weekendRate: CARS[car].weekend,
    rental, feePerDay: EXTENSION_DAILY_FEE * 100, fee, taxPct, tax, total: rental + fee + tax };
}

/** Is the car free for this renter to keep until newTo? */
function freeUntil(list, b, newTo, t) { return freeFor(list, b, { from: b.from, to: newTo }, t); }
function freeFor(list, b, r, t) { return !list.some(o => o.id !== b.id && isActive(o, t) && clashes(o, r)); }

/** Price of moving a trip to new dates/times, before pickup. Compares the new trip price with everything paid so far. */
export function changeQuote(car, b, input, t) {
  const r = validateRequest({ car, location: b.location, from: input.from, to: input.to, fromTime: input.fromTime || b.fromTime, toTime: input.toTime || b.toTime }, new Date(t));
  if (r.from === b.from && r.to === b.to && r.fromTime === b.fromTime && r.toTime === b.toTime) throw coded("same_dates", "Those are your current dates and times.");
  if (t + 2 * H > localMs(r.from, r.fromTime)) throw coded("too_soon", `The new pickup needs to be at least 2 hours from now. Text us at ${BUSINESS.phone} for same-day changes.`);
  const q = quote({ car, location: b.location, days: r.days, from: r.from, credits: b.credits || [] });
  const paid = (b.amountPaid || b.total || 0) + extraPayments(b).reduce((a, e) => a + e.amount, 0);
  return { from: r.from, to: r.to, fromTime: r.fromTime, toTime: r.toTime, days: r.days, newTotal: q.total, paid, diff: q.total - paid,
    weekdays: q.weekdays, weekends: q.weekends, weekdayRate: q.weekdayRate, weekendRate: q.weekendRate, discountLabel: q.discountLabel, taxPct: q.taxPct };
}

/** What My trips shows for each trip. */
export function tripExtras(car, b, t, settings, review) {
  const out = { cancel: cancelTerms(b, t) };
  const end = localMs(b.to, b.toTime);
  if (b.extension) out.extension = { status: b.extension.status, to: b.extension.to, total: b.extension.quote && b.extension.quote.total, at: b.extension.requestedAt };
  out.canExtend = b.status === "confirmed" && settings.extensionsAllowed && t < end && !pendingExt(b) && !pendingChange(b);
  out.canChange = b.status === "confirmed" && settings.extensionsAllowed && t + 2 * H < localMs(b.from, b.fromTime) && !pendingExt(b) && !pendingChange(b);
  if (b.change) out.change = { status: b.change.status, from: b.change.from, to: b.change.to, fromTime: b.change.fromTime, toTime: b.change.toTime, diff: b.change.quote && b.change.quote.diff };
  out.extensionsOff = !settings.extensionsAllowed;
  const ended = b.status === "confirmed" && (t >= end || !!(b.inspection && b.inspection.return));
  out.review = review ? { done: true, stars: review.stars } : { done: false, canReview: ended };
  if (b.cancellation) out.cancellation = { refund: (b.cancellation.refund || 0) + (b.cancellation.extensionRefund || 0), fee: b.cancellation.fee, status: b.cancellation.status };
  return out;
}

/* ---------- charging the saved card ---------- */

/** Charge the card saved at checkout without the renter present. Returns the PaymentIntent. */
export async function chargeSavedCard(stripe, b, { amount, description, metadata, key }) {
  const rentalPi = b.paymentIntent || b.paymentIntentId;
  if (!rentalPi) throw coded("no_payment", "There's no payment on file for this booking.", 409);
  const pi = await stripe.paymentIntents.retrieve(rentalPi);
  const pm = idOf(pi.payment_method), customer = idOf(pi.customer);
  if (!pm || !customer) throw coded("no_saved_card", "The renter's card wasn't saved, so it can't be charged automatically. Collect from the deposit hold or ask them to pay.", 409);
  try {
    const out = await stripe.paymentIntents.create({ amount, currency: "usd", customer, payment_method: pm, confirm: true, off_session: true,
      description, metadata, ...(renterEmail(b) ? { receipt_email: renterEmail(b) } : {}) }, { idempotencyKey: key });
    if (out.status === "succeeded" || out.status === "processing") return out;
    throw coded("not_paid", `The card wasn't charged (status ${out.status}).`, 402);
  } catch (e) {
    if (!isStripe(e)) throw e;
    const needsAction = e.code === "authentication_required" || (e.raw && e.raw.payment_intent && e.raw.payment_intent.status === "requires_action");
    throw coded(needsAction ? "authentication_required" : (e.code || "card_error"),
      needsAction ? "The renter's bank wants them to approve this charge, so it couldn't go through automatically. Collect from the deposit hold, or send them a payment link from Stripe."
        : `The card was declined: ${e.message}`, 402);
  }
}

/* ---------- post-trip charges ---------- */

const handling = () => POLICY.ticketAdminFee || 0;
export const CHARGE_TYPES = {
  late:     { label: "Late return fee", hint: () => `${usd(POLICY.lateFee * 100)} after the ${POLICY.lateGraceMinutes}-minute grace period` },
  lateDays: { label: "Extra days late", hint: () => "Daily rate for each day or part day more than 24 hours late", qty: "Days late" },
  miles:    { label: "Extra miles", hint: () => `Per mile over the included miles: ${extraMileList()}`, qty: "Miles over" },
  fuel:     { label: "Fuel", hint: () => `Cost of fuel plus ${usd(POLICY.fuelServiceFee * 100)} service fee`, cost: "Fuel cost" },
  cleaning: { label: "Cleaning fee", hint: () => usd(POLICY.cleaningFee * 100) },
  smoking:  { label: "Smoking fee", hint: () => usd(SMOKING_FEE * 100) },
  toll:     { label: "Tolls", hint: () => `At cost plus ${usd(handling() * 100)} handling per toll`, cost: "Toll total", qty: "Number of tolls" },
  ticket:   { label: "Ticket or fine", hint: () => `At cost plus ${usd(handling() * 100)} handling per ticket`, cost: "Ticket total", qty: "Number of tickets" },
  other:    { label: "Other (damage, etc.)", hint: () => "Any other amount owed under the agreement; say what it's for", cost: "Amount" },
};
export const chargeTypesForPage = () => Object.fromEntries(Object.entries(CHARGE_TYPES).map(([k, v]) => [k, { label: v.label, hint: v.hint(), qty: v.qty || null, cost: v.cost || null }]));

/** Price a post-trip charge. qty = count (days, miles, tolls), cost = dollars. Returns { lines, total } in cents. */
export function priceCharge(car, b, { type, qty, cost, note }) {
  if (!CHARGE_TYPES[type]) throw coded("bad_type", "Choose what you're charging for.");
  const n = qty === undefined || qty === null || qty === "" ? 1 : Number(qty);
  const c = Math.round(Number(String(cost ?? 0).replace(/[$,]/g, "")) * 100);
  const needN = (max, what) => { if (!Number.isInteger(n) || n < 1 || n > max) throw coded("bad_qty", `Enter the number of ${what} (1 to ${max}).`); };
  const needC = (min = 1) => { if (!Number.isFinite(c) || c < min || c > 2000000) throw coded("bad_amount", "Enter the amount in dollars."); };
  const lines = [], add = (label, amount) => { if (amount > 0) lines.push({ label, amount }); };
  switch (type) {
    case "late": add(`Late return fee (after ${POLICY.lateGraceMinutes}-minute grace period)`, POLICY.lateFee * 100); break;
    case "lateDays": { needN(60, "days late"); const dr = dayRates(car, b.to, n); add(`${n} extra day${n > 1 ? "s" : ""} late at the daily rate`, dr.subtotal * 100); break; }
    case "miles": { needN(20000, "miles over"); const rate = Math.round(CARS[car].extraMile * 100); add(`${n.toLocaleString("en-US")} extra mile${n > 1 ? "s" : ""} at ${usd(rate)}`, n * rate); break; }
    case "fuel": if (!Number.isFinite(c) || c < 0 || c > 100000) throw coded("bad_amount", "Enter the fuel cost in dollars (0 if none)."); add("Fuel to refill the tank", c); add("Fuel service fee", POLICY.fuelServiceFee * 100); break;
    case "cleaning": add("Cleaning fee", POLICY.cleaningFee * 100); break;
    case "smoking": add("Smoking remediation fee", SMOKING_FEE * 100); break;
    case "toll": case "ticket": {
      needN(200, type === "toll" ? "tolls" : "tickets"); needC();
      const what = type === "toll" ? "Toll" : "Ticket";
      add(n > 1 ? `${what}s (${n}) at cost` : `${what} at cost`, c);
      add(`Handling fee (${n} x ${usd(handling() * 100)})`, n * handling() * 100);
      break;
    }
    case "other": needC(50); if (!String(note || "").trim()) throw coded("note_required", "Say what this charge is for."); add(String(note).trim().slice(0, 80), c); break;
  }
  const total = lines.reduce((a, l) => a + l.amount, 0);
  if (total < 50) throw coded("bad_amount", "The total must be at least $0.50.");
  return { type, label: CHARGE_TYPES[type].label, lines, total };
}

/* ---------- the shared engine ---------- */

export function makeTrips({ store, stripe, now = () => Date.now(), mailer = null, siteUrl = "", notify = null, referrals = null, log = console }) {
  const repo = makeRepo(store, { now });
  const deposits = makeDeposits({ store, stripe, now, notify, log });
  const mail = async (to, subject, body, extra = {}) => {
    if (!mailer || !to) return false;
    try { await mailer.send({ to, subject, ...body, ...extra }); return true; } catch (e) { log.error("[trips] email failed", e && e.message); return false; }
  };
  const toOwner = (subject, body) => mail(mailer && mailer.ownerEmail, subject, body);

  /** by "renter" (policy, before pickup only) or "owner" with refund "policy" | "full" | "none" (any time). */
  async function cancel(car, b, by = "renter", { refund: mode = "policy" } = {}) {
    let terms;
    if (by === "renter") { terms = cancelTerms(b, now()); if (!terms.allowed) throw coded("not_allowed", terms.reason, 409); }
    else {
      if (!["confirmed", "conflict"].includes(b.status)) throw coded("not_allowed", "Only paid trips can be cancelled and refunded here.", 409);
      const p = policyTerms(b, now());
      terms = mode === "full" ? { ...p, fee: 0, refund: p.paid, totalRefund: p.paid + p.extensionRefund, free: true }
        : mode === "none" ? { ...p, fee: 0, refund: 0, extensionRefund: 0, totalRefund: 0 } : p;
      terms.mode = mode;
    }
    const at = iso(now());
    const changed = await repo.change(car, b.id, x => {
      if (x.status !== "confirmed" && !(by === "owner" && x.status === "conflict")) return undefined;
      x.previousStatus = x.status; x.status = "cancelled"; x.cancelledAt = at;
      x.cancellation = { by, at, free: terms.free, fee: terms.fee, refund: terms.refund, extensionRefund: terms.extensionRefund, status: "pending", ...(terms.mode ? { mode: terms.mode } : {}) };
      return x;
    });
    if (!changed) throw coded("not_allowed", "This trip can't be cancelled.", 409);
    const refunds = []; let error = null;
    try {
      const pay = changed.paymentIntent || changed.paymentIntentId;
      if (terms.refund > 0 && pay) refunds.push((await stripe.refunds.create({ payment_intent: pay, amount: terms.refund, reason: "requested_by_customer",
        metadata: { kind: "cancellation", car, booking_id: b.id } }, { idempotencyKey: `cancel-refund-${b.id}` })).id);
      if (terms.extensionRefund) for (const e of extraPayments(changed))
        refunds.push((await stripe.refunds.create({ payment_intent: e.paymentIntentId, reason: "requested_by_customer", metadata: { kind: "cancellation", car, booking_id: b.id } },
          { idempotencyKey: `cancel-refund-${e.paymentIntentId}` })).id);
    } catch (e) { if (!isStripe(e)) throw e; error = String(e.message || e).slice(0, 200); log.error(`[trips] refund failed ${car} ${b.id}: ${error}`); }
    const done = await repo.note(car, b.id, { cancellation: { ...changed.cancellation, status: error ? "refund_failed" : "refunded", refunds, ...(error ? { error } : {}) } });
    try { await deposits.release(car, done, "trip cancelled"); } catch (e) { log.error("[trips] deposit release on cancel", e && e.message); }
    if (referrals) { try { await referrals.onCancelled(car, done); } catch (e) { log.error("[trips] credit restore", e && e.message); } }
    const rows = [["Trip", tripLine(car, b)], ["Paid", usd(terms.paid + terms.extensionRefund)],
      ...(terms.fee ? [["Cancellation fee", "-" + usd(terms.fee)]] : []), ["Refund", usd(terms.totalRefund), true]];
    await mail(renterEmail(b), `Trip cancelled: ${tripLine(car, b)}`, simpleEmail(`Your trip is cancelled`, [
      by === "owner" ? `Hi ${firstName(b)}, we've cancelled your ${CARS[car].name} trip. We're sorry for any trouble this causes.` : `Hi ${firstName(b)}, your ${CARS[car].name} trip is cancelled.`,
      terms.totalRefund ? `Your refund of ${usd(terms.totalRefund)} is on its way to the card you paid with. Refunds usually show up in 5 to 10 business days.` : "There's no refund for this trip.",
      ...(terms.fee ? [`A ${usd(terms.fee)} cancellation fee applies because the trip was cancelled more than 24 hours after booking.`] : []),
      ...(b.deposit && b.deposit.status === "held" ? ["The security deposit hold on your card has been released."] : []),
    ], rows));
    if (by === "renter" || error) await toOwner(`Trip cancelled by ${by === "renter" ? "the renter" : "you"}: ${tripLine(car, b)}`, simpleEmail("Trip cancelled", [
      by === "renter" ? `${(b.customer && b.customer.name) || "The renter"} cancelled this trip in My trips. The dates are open again.` : "You cancelled this trip on your bookings page. The dates are open again.",
      error ? `The automatic refund didn't go through (${error}). Refund ${usd(terms.totalRefund)} in your Stripe dashboard.` : terms.totalRefund ? `${usd(terms.totalRefund)} was refunded automatically.` : "No refund was due.",
    ], rows));
    return { ...terms, refundFailed: !!error };
  }

  async function requestExtension(car, b, newTo, { dryRun = false } = {}) {
    const settings = await getSettings(store);
    if (!settings.extensionsAllowed) throw coded("extensions_off", `Trip extensions can't be requested online right now. Text us at ${BUSINESS.phone} and we'll see what we can do.`, 409);
    if (b.status !== "confirmed") throw coded("not_allowed", "Only booked trips can be extended.", 409);
    if (now() >= localMs(b.to, b.toTime)) throw coded("too_late", `Your return time has passed. Text us at ${BUSINESS.phone}.`, 409);
    if (pendingExt(b) || pendingChange(b)) throw coded("pending", "You already have a request waiting for an answer.", 409);
    const q = extensionQuote(car, b, newTo);
    const list = await repo.all(car);
    if (!freeUntil(list, b, newTo, now())) throw coded("unavailable", "Sorry, the car is booked by someone else on those dates. Try an earlier return date, or text us.", 409);
    if (dryRun) return { quote: q };
    const at = iso(now());
    const saved = await repo.change(car, b.id, (x, all) => {
      if (x.status !== "confirmed" || pendingExt(x) || pendingChange(x)) throw coded("pending", "You already have a request waiting for an answer.", 409);
      if (!freeUntil(all, x, newTo, now())) throw coded("unavailable", "Sorry, the car was just booked by someone else on those dates.", 409);
      x.extension = { status: "requested", to: newTo, toTime: x.toTime, quote: q, requestedAt: at, attempts: 0 };
      return x;
    });
    await toOwner(`Extension request: ${CARS[car].name}, keep until ${niceDate(newTo)}`, simpleEmail("A renter wants to extend their trip", [
      `${(b.customer && b.customer.name) || "A renter"} wants to keep the ${CARS[car].name} until ${niceDate(newTo)}, ${t12(b.toTime)} (${q.days} more day${q.days > 1 ? "s" : ""}). Those dates are held for them until you decide.`,
      { html: `<a href="${esc(siteUrl)}/admin.html">Approve or decline on your bookings page</a>. Approving charges their card ${esc(usd(q.total))}.`, text: `Approve or decline on your bookings page: ${siteUrl}/admin.html. Approving charges their card ${usd(q.total)}.` },
    ], quoteRows(car, b, q)));
    return { extension: saved.extension, quote: q };
  }

  async function withdrawExtension(car, b) {
    const saved = await repo.change(car, b.id, x => {
      if (!x.extension || x.extension.status !== "requested") return undefined;
      x.extension = { ...x.extension, status: "withdrawn", decidedAt: iso(now()) }; return x;
    });
    if (!saved) throw coded("not_pending", "There's no extension request to withdraw.", 409);
    return { extension: saved.extension };
  }

  async function approveExtension(car, b) {
    const ext = b.extension;
    if (!pendingExt(b)) throw coded("not_pending", "There's no extension request to approve.", 409);
    if (b.status !== "confirmed") throw coded("not_allowed", "This trip isn't active.", 409);
    const attempts = (ext.attempts || 0) + 1;
    let pi;
    try {
      pi = await chargeSavedCard(stripe, b, { amount: ext.quote.total, key: `ext-${b.id}-${ext.requestedAt}-${attempts}`,
        description: `Trip extension: ${CARS[car].name}, ${b.to} to ${ext.to}`, metadata: { kind: "extension", car, booking_id: b.id, from: b.to, to: ext.to } });
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
      await repo.change(car, b.id, x => { x.extension = { ...x.extension, status: "payment_failed", attempts, error: e.message.slice(0, 300), failedAt: iso(now()) }; return x; });
      await mail(renterEmail(b), "We couldn't charge your card for your extension", simpleEmail("Your extension isn't confirmed yet", [
        `Hi ${firstName(b)}, we approved your request to keep the ${CARS[car].name} until ${niceDate(ext.to)}, but the card you booked with couldn't be charged ${usd(ext.quote.total)}.`,
        `Please text us at ${BUSINESS.phone} to sort out payment. Until then, your return time is still ${niceDate(b.to)}, ${t12(b.toTime)}.`,
      ]));
      throw e;
    }
    const at = iso(now());
    const saved = await repo.change(car, b.id, x => {
      const from = x.to;
      x.extensions = [...(x.extensions || []), { from, to: ext.to, days: ext.quote.days, amount: ext.quote.total, paymentIntentId: pi.id, approvedAt: at }];
      x.to = ext.to; x.toTime = ext.toTime || x.toTime;
      x.extension = { ...x.extension, status: "approved", decidedAt: at, paymentIntentId: pi.id, attempts, error: null };
      return x;
    });
    await mail(renterEmail(b), `Extension approved: keep the ${CARS[car].name} until ${niceDate(ext.to)}`, simpleEmail("Your trip is extended", [
      `Hi ${firstName(b)}, good news: your trip is extended. Your new return is ${niceDate(ext.to)}, ${t12(saved.toTime)}.`,
      `We charged ${usd(ext.quote.total)} to the card you booked with. Everything else in your rental agreement stays the same.`,
    ], quoteRows(car, b, ext.quote)));
    return { booking: saved };
  }

  async function declineExtension(car, b) {
    if (!pendingExt(b)) throw coded("not_pending", "There's no extension request to decline.", 409);
    const saved = await repo.change(car, b.id, x => { x.extension = { ...x.extension, status: "declined", decidedAt: iso(now()) }; return x; });
    await mail(renterEmail(b), "About your extension request", simpleEmail("We can't extend this trip", [
      `Hi ${firstName(b)}, sorry, we can't extend your ${CARS[car].name} trip to ${niceDate(b.extension.to)}. Please return the car as planned on ${niceDate(b.to)}, ${t12(b.toTime)}.`,
      `You haven't been charged anything for the request.`,
    ]));
    return { booking: saved };
  }

  async function charge(car, b, input) {
    if (!["confirmed", "cancelled"].includes(b.status)) throw coded("not_allowed", "Only paid trips can be charged.", 409);
    const priced = priceCharge(car, b, input);
    const note = String(input.note || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300);
    const id = randomBytes(6).toString("hex"), at = iso(now()), source = input.source === "deposit" ? "deposit" : "card";
    const rec = { id, type: priced.type, label: priced.label, lines: priced.lines, total: priced.total, note, source, at };
    let error = null, piId = null;
    try {
      if (source === "deposit") {
        const d = await deposits.capture(car, b, priced.total, `${priced.label}${note ? ": " + note : ""}`).catch(e => { if (e && (e.code === "no_hold" || e.code === "bad_amount")) throw coded(e.code, e.message, 409); throw e; });
        piId = d.paymentIntentId;
      } else {
        piId = (await chargeSavedCard(stripe, b, { amount: priced.total, key: `charge-${b.id}-${id}`,
          description: `${priced.label}: ${CARS[car].name}, ${b.from} to ${b.to}`, metadata: { kind: "charge", charge_type: priced.type, car, booking_id: b.id, note: note.slice(0, 400) } })).id;
      }
    } catch (e) { if (!(e instanceof BookingError)) throw e; error = e; }
    const canLink = error && source === "card";
    const saved = { ...rec, status: error ? "failed" : "paid", ...(piId ? { paymentIntentId: piId } : {}), ...(error ? { error: error.message.slice(0, 300) } : {}),
      ...(canLink ? { payToken: randomBytes(18).toString("base64url") } : {}) };
    await repo.change(car, b.id, x => { x.charges = [...(x.charges || []), saved]; return x; });
    if (error) {
      if (canLink && await sendPayLink(car, { ...b, charges: [...(b.charges || []), saved] }, saved.id))
        throw coded(error.code, `${error.message} We emailed the renter a secure link to pay it instead.`, error.status);
      throw error;
    }
    await mail(renterEmail(b), `Charges for your trip: ${tripLine(car, b)}`, simpleEmail("Itemized statement for your trip", [
      `Hi ${firstName(b)}, here's an itemized statement for charges from your ${CARS[car].name} trip under your rental agreement.`,
      ...(note ? [`Details: ${note}`] : []),
      source === "deposit" ? "This was collected from your security deposit hold. The rest of the hold has been released." : "This was charged to the card you booked with.",
    ], [...priced.lines.map(l => [l.label, usd(l.amount)]), ["Total", usd(priced.total), true]], "If anything looks wrong, let us know within 7 days."));
    return { charge: saved };
  }

  /** Email the renter a link to pay a charge their saved card couldn't cover (pay.html opens a fresh Stripe checkout). */
  async function sendPayLink(car, b, chargeId) {
    const c = (b.charges || []).find(x => x.id === chargeId);
    if (!c || c.status === "paid") throw coded("not_found", "That charge isn't waiting for payment.", 409);
    let token = c.payToken;
    if (!token) { token = randomBytes(18).toString("base64url"); await repo.change(car, b.id, x => { const y = (x.charges || []).find(z => z.id === chargeId); if (y) y.payToken = token; return x; }); }
    const link = `${siteUrl}/pay.html?car=${car}&ref=${b.id}&c=${chargeId}&t=${token}`;
    const sent = await mail(renterEmail(b), `Payment needed: ${c.label} for your ${CARS[car].name} trip`, simpleEmail("A payment is due for your trip", [
      `Hi ${firstName(b)}, we tried to charge the card you booked with for the amount below, but it didn't go through.`,
      ...(c.note ? [`Details: ${c.note}`] : []),
      { html: `Please pay securely through Stripe here:<br><br><a href="${esc(link)}" style="display:inline-block;background:#DAA336;color:#15130F;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px">Pay ${esc(usd(c.total))}</a>`,
        text: `Please pay securely through Stripe here: ${link}` },
    ], [...c.lines.map(l => [l.label, usd(l.amount)]), ["Total due", usd(c.total), true]], "Under your rental agreement, amounts owed are due when we send this statement."));
    if (sent) await repo.change(car, b.id, x => { const y = (x.charges || []).find(z => z.id === chargeId); if (y) y.linkSentAt = iso(now()); return x; });
    return sent;
  }

  /* ----- date changes (before pickup): the renter asks, the owner approves ----- */
  async function requestChange(car, b, input, { dryRun = false } = {}) {
    const settings = await getSettings(store);
    if (!settings.extensionsAllowed) throw coded("changes_off", `Trip changes can't be requested online right now. Text us at ${BUSINESS.phone}.`, 409);
    if (b.status !== "confirmed") throw coded("not_allowed", "Only booked trips can be changed.", 409);
    if (now() + 2 * H >= localMs(b.from, b.fromTime)) throw coded("too_late", `Your pickup is too soon to change online. Text us at ${BUSINESS.phone}.`, 409);
    if (pendingExt(b) || pendingChange(b)) throw coded("pending", "You already have a request waiting for an answer.", 409);
    const q = changeQuote(car, b, input || {}, now());
    if (!freeFor(await repo.all(car), b, q, now())) throw coded("unavailable", "Sorry, the car is booked by someone else on those dates. Try different dates, or text us.", 409);
    if (dryRun) return { quote: q };
    const saved = await repo.change(car, b.id, (x, all) => {
      if (x.status !== "confirmed" || pendingExt(x) || pendingChange(x)) throw coded("pending", "You already have a request waiting for an answer.", 409);
      if (!freeFor(all, x, q, now())) throw coded("unavailable", "Sorry, the car was just booked by someone else on those dates.", 409);
      x.change = { status: "requested", from: q.from, to: q.to, fromTime: q.fromTime, toTime: q.toTime, quote: q, requestedAt: iso(now()), attempts: 0 };
      return x;
    });
    const money = q.diff > 0 ? `Approving charges their card ${usd(q.diff)} more.` : q.diff < 0 ? `Approving refunds them ${usd(-q.diff)}.` : "The price stays the same.";
    await toOwner(`Date change request: ${CARS[car].name}`, simpleEmail("A renter wants to change their dates", [
      `${(b.customer && b.customer.name) || "A renter"} wants to move their ${CARS[car].name} trip.`,
      { html: `${esc(money)} <a href="${esc(siteUrl)}/admin.html">Approve or decline on your bookings page</a>.`, text: `${money} Approve or decline on your bookings page: ${siteUrl}/admin.html` },
    ], [["Now", `${niceDate(b.from)} ${t12(b.fromTime)} to ${niceDate(b.to)} ${t12(b.toTime)}`], ["Wants", `${niceDate(q.from)} ${t12(q.fromTime)} to ${niceDate(q.to)} ${t12(q.toTime)}`],
      ["New trip price", usd(q.newTotal)], ["Paid so far", usd(q.paid)], [q.diff >= 0 ? "Difference to charge" : "Difference to refund", usd(Math.abs(q.diff)), true]]));
    return { change: saved.change, quote: q };
  }

  async function withdrawChange(car, b) {
    const saved = await repo.change(car, b.id, x => { if (!x.change || x.change.status !== "requested") return undefined; x.change = { ...x.change, status: "withdrawn", decidedAt: iso(now()) }; return x; });
    if (!saved) throw coded("not_pending", "There's no date change to withdraw.", 409);
    return { change: saved.change };
  }

  async function approveChange(car, b) {
    if (!pendingChange(b)) throw coded("not_pending", "There's no date change to approve.", 409);
    if (b.status !== "confirmed") throw coded("not_allowed", "This trip isn't active.", 409);
    const c = b.change, q = c.quote, attempts = (c.attempts || 0) + 1, at = iso(now());
    let adj = null;
    if (q.diff > 0) {
      try {
        const pi = await chargeSavedCard(stripe, b, { amount: q.diff, key: `chg-${b.id}-${c.requestedAt}-${attempts}`,
          description: `Date change: ${CARS[car].name}, now ${q.from} to ${q.to}`, metadata: { kind: "change", car, booking_id: b.id, from: q.from, to: q.to } });
        adj = { kind: "change", amount: q.diff, paymentIntentId: pi.id, at };
      } catch (e) {
        if (!(e instanceof BookingError)) throw e;
        await repo.change(car, b.id, x => { x.change = { ...x.change, status: "payment_failed", attempts, error: e.message.slice(0, 300), failedAt: at }; return x; });
        await mail(renterEmail(b), "We couldn't charge your card for your date change", simpleEmail("Your date change isn't confirmed yet", [
          `Hi ${firstName(b)}, we approved moving your ${CARS[car].name} trip, but the card you booked with couldn't be charged the ${usd(q.diff)} difference.`,
          `Please text us at ${BUSINESS.phone}. Until then, your trip stays on ${niceDate(b.from)} to ${niceDate(b.to)}.`]));
        throw e;
      }
    } else if (q.diff < 0) {
      const pay = b.paymentIntent || b.paymentIntentId, amount = Math.min(-q.diff, b.amountPaid || b.total || 0);
      let refundId = null;
      if (pay && amount > 0) refundId = (await stripe.refunds.create({ payment_intent: pay, amount, reason: "requested_by_customer", metadata: { kind: "change", car, booking_id: b.id } },
        { idempotencyKey: `chg-refund-${b.id}-${c.requestedAt}` })).id;
      adj = { kind: "change_refund", amount: -amount, refundId, at };
    }
    const saved = await repo.change(car, b.id, x => {
      const was = { from: x.from, to: x.to, fromTime: x.fromTime, toTime: x.toTime };
      Object.assign(x, { from: q.from, to: q.to, fromTime: q.fromTime, toTime: q.toTime });
      if (adj) { x.adjustments = [...(x.adjustments || []), { ...adj, was }]; if (adj.amount < 0) x.amountPaid = (x.amountPaid || x.total || 0) + adj.amount; }
      x.change = { ...x.change, status: "approved", decidedAt: at, attempts, error: null, was };
      x.pickupReminderAt = null; x.returnReminderAt = null;
      return x;
    });
    await mail(renterEmail(b), `Date change approved: ${CARS[car].name}, ${niceDate(q.from)} to ${niceDate(q.to)}`, simpleEmail("Your trip has new dates", [
      `Hi ${firstName(b)}, your ${CARS[car].name} trip is now ${niceDate(q.from)}, ${t12(q.fromTime)} to ${niceDate(q.to)}, ${t12(q.toTime)}.`,
      q.diff > 0 ? `We charged the ${usd(q.diff)} difference to the card you booked with.` : q.diff < 0 ? `We refunded ${usd(-adj.amount)} to the card you booked with. Refunds usually show up in 5 to 10 business days.` : "The price didn't change.",
      "Everything else in your rental agreement stays the same."]));
    return { booking: saved };
  }

  async function declineChange(car, b) {
    if (!pendingChange(b)) throw coded("not_pending", "There's no date change to decline.", 409);
    const saved = await repo.change(car, b.id, x => { x.change = { ...x.change, status: "declined", decidedAt: iso(now()) }; return x; });
    await mail(renterEmail(b), "About your date change request", simpleEmail("We can't change these dates", [
      `Hi ${firstName(b)}, sorry, we can't move your ${CARS[car].name} trip to the dates you asked for. Your trip stays on ${niceDate(b.from)}, ${t12(b.fromTime)} to ${niceDate(b.to)}, ${t12(b.toTime)}.`,
      "You haven't been charged anything for the request. Text us if you'd like to try other dates."]));
    return { booking: saved };
  }

  return { repo, deposits, cancel, requestExtension, withdrawExtension, approveExtension, declineExtension, charge, sendPayLink,
    requestChange, withdrawChange, approveChange, declineChange };
}

function quoteRows(car, b, q) {
  return [
    ["New return", `${niceDate(q.to)}, ${t12(q.toTime || b.toTime)}`],
    ...(q.weekdays ? [[`${q.weekdays} Mon-Thu day${q.weekdays > 1 ? "s" : ""} at ${usd(q.weekdayRate * 100)}`, usd(q.weekdays * q.weekdayRate * 100)]] : []),
    ...(q.weekends ? [[`${q.weekends} Fri-Sun day${q.weekends > 1 ? "s" : ""} at ${usd(q.weekendRate * 100)}`, usd(q.weekends * q.weekendRate * 100)]] : []),
    [`Extension fee (${q.days} x ${usd(q.feePerDay)})`, usd(q.fee)],
    [`${TAX.label} (${q.taxPct}%)`, usd(q.tax)],
    ["Total", usd(q.total), true],
  ];
}

/* ---------- HTTP ---------- */

const fail = (e, log = console) => {
  if (e instanceof BookingError) return json({ error: e.code, message: e.message }, e.status);
  if (isStripe(e)) { log.error("[trips] Stripe error", e.type, e.message); return json({ error: "stripe", message: "Our payment system didn't respond. Please try again in a minute." }, 502); }
  log.error("[trips] unexpected error", e);
  return json({ error: "server_error", message: "Something went wrong on our side. Please try again, or text us." }, 500);
};

/** POST /api/trip {action: cancel | extend-quote | extend | extend-withdraw, car, ref, to?, confirm?} (logged-in renter) */
export function tripHandler({ store, stripe, userOf, now = () => Date.now(), mailer = null, siteUrl = "", notify = null, referrals = null, log = console }) {
  const trips = makeTrips({ store, stripe, now, mailer, siteUrl, notify, referrals, log });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
    try {
      const u = userOf ? await userOf(req) : null;
      if (!u) return json({ error: "login_required", message: "Please log in to manage your trip." }, 401);
      const body = await readBody(req);
      const { car, ref, action } = body;
      if (!CARS[car] || typeof ref !== "string") return json({ error: "bad_request", message: "That trip wasn't found." }, 400);
      const b = await trips.repo.get(car, ref);
      if (!b || b.userId !== u.id) return json({ error: "not_found", message: "That trip wasn't found on your account." }, 404);
      if (action === "cancel") {
        if (body.confirm !== true) { const terms = cancelTerms(b, now()); return terms.allowed ? json({ ok: true, preview: terms }) : json({ error: "not_allowed", message: terms.reason }, 409); }
        return json({ ok: true, ...(await trips.cancel(car, b, "renter")) });
      }
      if (action === "extend-quote") return json({ ok: true, ...(await trips.requestExtension(car, b, body.to, { dryRun: true })) });
      if (action === "extend") return json({ ok: true, ...(await trips.requestExtension(car, b, body.to)) });
      if (action === "extend-withdraw") return json({ ok: true, ...(await trips.withdrawExtension(car, b)) });
      if (action === "change-quote") return json({ ok: true, ...(await trips.requestChange(car, b, body, { dryRun: true })) });
      if (action === "change") return json({ ok: true, ...(await trips.requestChange(car, b, body)) });
      if (action === "change-withdraw") return json({ ok: true, ...(await trips.withdrawChange(car, b)) });
      return json({ error: "bad_request" }, 400);
    } catch (e) { return fail(e, log); }
  };
}

/** POST /api/admin/trip with x-admin-key: {action: settings | extend-approve | extend-decline | charge-quote | charge | review-hide | review-show, ...} */
export function adminTripHandler({ store, stripe, adminKey, now = () => Date.now(), mailer = null, siteUrl = "", notify = null, referrals = null, reviews = null, log = console }) {
  const trips = makeTrips({ store, stripe, now, mailer, siteUrl, notify, referrals, log });
  return async (req) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (!keyOk(req, adminKey)) return json({ error: "unauthorized" }, 401);
    try {
      const body = await readBody(req);
      const { action, car, id } = body;
      if (action === "settings") return json({ ok: true, settings: await saveSettings(store, body) });
      if (action === "review-hide" || action === "review-show") {
        if (!reviews) return json({ error: "bad_request" }, 400);
        return json({ ok: true, review: await reviews.setHidden(String(id || ""), action === "review-hide") });
      }
      if (!CARS[car] || typeof id !== "string") return json({ error: "bad_request" }, 400);
      const b = await trips.repo.get(car, id);
      if (!b) return json({ error: "not_found", message: "Booking not found." }, 404);
      if (action === "extend-approve") return json({ ok: true, ...(await trips.approveExtension(car, b)) });
      if (action === "extend-decline") return json({ ok: true, ...(await trips.declineExtension(car, b)) });
      if (action === "charge-quote") return json({ ok: true, quote: priceCharge(car, b, body) });
      if (action === "charge") return json({ ok: true, ...(await trips.charge(car, b, body)) });
      if (action === "pay-link") { const sent = await trips.sendPayLink(car, b, String(body.chargeId || "")); return sent ? json({ ok: true }) : json({ error: "email_off", message: "Email isn't set up, so the link couldn't be sent." }, 503); }
      if (action === "change-approve") return json({ ok: true, ...(await trips.approveChange(car, b)) });
      if (action === "change-decline") return json({ ok: true, ...(await trips.declineChange(car, b)) });
      if (action === "cancel") {
        const mode = ["policy", "full", "none"].includes(body.refund) ? body.refund : "policy";
        return json({ ok: true, ...(await trips.cancel(car, b, "owner", { refund: mode })) });
      }
      return json({ error: "bad_request" }, 400);
    } catch (e) { return fail(e, log); }
  };
}
