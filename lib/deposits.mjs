// Security deposit holds (rental agreement section 5).
// The renter's card is saved when they pay (setup_future_usage). We then place a separate
// Stripe PaymentIntent with capture_method "manual": an authorization hold, not a charge.
//   - placed right after payment if pickup is within DEPOSIT_LEAD_HOURS, otherwise by the hourly
//     job (netlify/functions/deposit-holds.mjs) about DEPOSIT_LEAD_HOURS before pickup
//   - renewed if it would expire while still needed (card holds last ~7 days, up to 30 with extended auth)
//   - released automatically DEPOSIT_RELEASE_HOURS after the scheduled return, unless the owner
//     pressed "Keep hold" on the bookings page; the owner can also collect part or all of it
// Booking field: deposit = { status: scheduled|held|failed|released|captured|none, amount (cents),
//   paymentIntentId, placedAt, captureBefore, extended, attempts, error, keep, capturedAmount, ... }
import { CARS, DEPOSITS, DEPOSIT_LEAD_HOURS, DEPOSIT_RELEASE_HOURS, DEPOSIT_RENEW_HOURS, TIMEZONE } from "./catalog.mjs";
import { makeRepo } from "./bookings.mjs";

const H = 3600e3;
const MAX_AUTO_ATTEMPTS = 3;

function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
/** "2026-11-01" + "10:00" in Dallas time -> epoch ms */
export function localMs(date, time = "00:00", tz = TIMEZONE) {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - tzOffset(guess, tz);
  const again = guess - tzOffset(ms, tz);
  return again !== ms ? again : ms;
}
export const depositCents = car => Math.round((DEPOSITS[car] || 0) * 100);
export const placeAt = b => localMs(b.from, b.fromTime) - DEPOSIT_LEAD_HOURS * H;
export const releaseAt = b => localMs(b.to, b.toTime) + DEPOSIT_RELEASE_HOURS * H;

const isStripe = e => e && e.type && String(e.type).startsWith("Stripe");
const idOf = x => (x && typeof x === "object" ? x.id : x) || null;

export function makeDeposits({ store, stripe, now = () => Date.now(), notify = null, log = console }) {
  const repo = makeRepo(store, { now });
  const setDeposit = (car, id, fields) => repo.note(car, id, { deposit: fields });
  const tell = async (subject, text) => { if (notify) { try { await notify(subject, text); } catch (e) { log.error("[deposit] owner notice failed", e && e.message); } } };

  /** Put the hold on now. Returns the updated deposit record. */
  async function place(car, b, { renewing = false } = {}) {
    const amount = depositCents(car), prev = b.deposit || {};
    if (!amount) return setDeposit(car, b.id, { ...prev, status: "none" }).then(x => x && x.deposit);
    const rentalPi = b.paymentIntent || b.paymentIntentId;
    const attempts = (prev.attempts || 0) + 1;
    try {
      if (!rentalPi) throw Object.assign(new Error("No payment on file for this booking."), { code: "no_payment" });
      const pi = await stripe.paymentIntents.retrieve(rentalPi, { expand: ["payment_method"] });
      const pm = idOf(pi.payment_method), customer = idOf(pi.customer);
      if (!pm || !customer) throw Object.assign(new Error("The renter's card wasn't saved, so a hold can't be placed automatically."), { code: "no_saved_card" });
      const isCard = !(pi.payment_method && typeof pi.payment_method === "object" && pi.payment_method.type && pi.payment_method.type !== "card");
      const m = pi.metadata || {};
      const hold = await stripe.paymentIntents.create({
        amount, currency: "usd", customer, payment_method: pm,
        capture_method: "manual", confirm: true, off_session: true,
        ...(isCard ? { payment_method_options: { card: { request_extended_authorization: "if_available" } } } : {}),
        description: `Security deposit hold (refundable): ${CARS[car].name}, ${b.from} to ${b.to}`,
        metadata: { kind: "deposit", car, booking_id: b.id, rental_payment: rentalPi,
          contract_version: m.contract_version || "", contract_sha256: m.contract_sha256 || "", contract_signed_at: m.contract_signed_at || "" },
        expand: ["latest_charge"],
      }, { idempotencyKey: `deposit-${b.id}-${attempts}` });
      if (hold.status !== "requires_capture") throw Object.assign(new Error(`Hold not authorized (status ${hold.status}).`), { code: hold.status });
      const card = hold.latest_charge && hold.latest_charge.payment_method_details && hold.latest_charge.payment_method_details.card;
      const rec = { status: "held", amount, paymentIntentId: hold.id, placedAt: new Date(now()).toISOString(), attempts,
        captureBefore: card && card.capture_before ? new Date(card.capture_before * 1000).toISOString() : new Date(now() + 7 * 24 * H).toISOString(),
        extended: !!(card && card.extended_authorization && card.extended_authorization.status === "enabled"), keep: !!prev.keep,
        ...(renewing ? { renewedFrom: prev.paymentIntentId } : {}) };
      return (await setDeposit(car, b.id, rec)).deposit;
    } catch (e) {
      if (!isStripe(e) && !e.code) throw e;
      const msg = (e && e.message) || "Hold failed";
      log.error(`[deposit] hold failed for ${car} ${b.id}: ${msg}`);
      // a failed renewal keeps the current hold (it is still valid until it expires)
      const rec = renewing
        ? { ...prev, attempts, renewFailedAt: new Date(now()).toISOString(), renewError: String(msg).slice(0, 200) }
        : { ...prev, status: "failed", amount, attempts, failedAt: new Date(now()).toISOString(), error: String(msg).slice(0, 200), code: e.code || e.type };
      const out = (await setDeposit(car, b.id, rec)).deposit;
      if (renewing ? !prev.renewFailedAt : (attempts === 1 || attempts >= MAX_AUTO_ATTEMPTS))
        await tell(`Deposit hold failed: ${CARS[car].name}, ${b.from}`, `The $${(amount / 100).toFixed(2)} deposit hold for ${(b.customer && b.customer.name) || "a renter"} (${b.from} to ${b.to}) could not be placed: ${msg}\nCollect a deposit at handoff or ask for another card. Open your bookings page to try again.`);
      return out;
    }
  }

  async function release(car, b, reason = "released") {
    const d = b.deposit || {};
    if (d.status !== "held" || !d.paymentIntentId) return d;
    try { await stripe.paymentIntents.cancel(d.paymentIntentId); }
    catch (e) { if (!isStripe(e)) throw e; log.warn(`[deposit] cancel ${d.paymentIntentId}: ${e.message}`); }
    return (await setDeposit(car, b.id, { ...d, status: "released", releasedAt: new Date(now()).toISOString(), releaseReason: reason })).deposit;
  }

  async function capture(car, b, cents, note = "") {
    const d = b.deposit || {};
    if (d.status !== "held" || !d.paymentIntentId) throw Object.assign(new Error("There's no active hold to collect from."), { code: "no_hold" });
    if (!Number.isInteger(cents) || cents < 50 || cents > d.amount) throw Object.assign(new Error(`Enter an amount between $0.50 and $${(d.amount / 100).toFixed(2)}.`), { code: "bad_amount" });
    if (note) await stripe.paymentIntents.update(d.paymentIntentId, { metadata: { capture_note: String(note).slice(0, 400) } });
    const pi = await stripe.paymentIntents.capture(d.paymentIntentId, { amount_to_capture: cents });
    return (await setDeposit(car, b.id, { ...d, status: "captured", capturedAmount: pi.amount_received || cents, capturedAt: new Date(now()).toISOString(), captureNote: String(note).slice(0, 400) })).deposit;
  }

  /** Called once when a booking is paid. */
  async function onConfirmed(car, b) {
    if (!b || b.status !== "confirmed" || (b.deposit && b.deposit.status)) return b && b.deposit;
    if (!depositCents(car)) return null;
    if (now() >= placeAt(b)) return place(car, b);
    return (await setDeposit(car, b.id, { status: "scheduled", amount: depositCents(car), placeAt: new Date(placeAt(b)).toISOString() })).deposit;
  }

  /** Hourly job: place due holds, retry failures, renew expiring ones, release finished ones. */
  async function sweep() {
    const t = now(), done = [];
    for (const car of Object.keys(CARS)) {
      for (const b of await repo.all(car)) {
        const d = b.deposit || {};
        try {
          if (b.status !== "confirmed") {
            if (d.status === "held") { await release(car, b, `booking ${b.status}`); done.push(["released", car, b.id]); }
            continue;
          }
          const due = placeAt(b), end = releaseAt(b);
          if ((!d.status || d.status === "scheduled") && t >= due && t < end) { await place(car, b); done.push(["placed", car, b.id]); }
          else if (d.status === "failed" && (d.attempts || 0) < MAX_AUTO_ATTEMPTS && t < end && t - Date.parse(d.failedAt || 0) >= H) { await place(car, b); done.push(["retried", car, b.id]); }
          else if (d.status === "held" && !d.keep && t >= end) { await release(car, b, "auto after return"); done.push(["released", car, b.id]); }
          else if (d.status === "held" && !d.keep && Date.parse(d.captureBefore) - t < DEPOSIT_RENEW_HOURS * H && Date.parse(d.captureBefore) < end
            && (!d.renewFailedAt || t - Date.parse(d.renewFailedAt) >= H)) {
            const old = d.paymentIntentId;
            const fresh = await place(car, b, { renewing: true });
            if (fresh && fresh.status === "held" && old && old !== fresh.paymentIntentId && !fresh.renewFailedAt) { try { await stripe.paymentIntents.cancel(old); } catch (e) { /* already expired */ } }
            done.push(["renewed", car, b.id]);
          }
        } catch (e) { log.error(`[deposit] sweep ${car} ${b.id}`, e); }
      }
    }
    return done;
  }

  /** Stripe webhook events for deposit PaymentIntents (metadata.kind === "deposit"). */
  async function onEvent(event) {
    const pi = event.data.object, m = pi.metadata || {};
    if (!CARS[m.car] || !m.booking_id) return;
    const b = await repo.get(m.car, m.booking_id);
    const d = b && b.deposit;
    if (!d || d.paymentIntentId !== pi.id) return;
    if (event.type === "payment_intent.canceled" && d.status === "held")
      await setDeposit(m.car, b.id, { ...d, status: "released", releasedAt: new Date(now()).toISOString(), releaseReason: pi.cancellation_reason === "automatic" ? "hold expired" : (pi.cancellation_reason || "cancelled") });
    else if (event.type === "payment_intent.succeeded" && d.status !== "captured")
      await setDeposit(m.car, b.id, { ...d, status: "captured", capturedAmount: pi.amount_received, capturedAt: new Date(now()).toISOString() });
  }

  return { place, release, capture, onConfirmed, sweep, onEvent, repo };
}
