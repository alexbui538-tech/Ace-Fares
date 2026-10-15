import { CARS, LOCATIONS, discountsFor, ratesFor, TAX, TAX_INCLUDES_FEES, MAX_DAYS, TIMES, TIMEZONE, WEEKEND_DAYS } from "./catalog.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayIn(tz = TIMEZONE, now = new Date()) {
  // YYYY-MM-DD for the given time zone
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isValidDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
}

export function niceDate(s) {
  return new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export class BookingError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Validate a booking request. Throws BookingError with a renter-friendly message. */
export function validateRequest(body, now = new Date()) {
  if (!body || typeof body !== "object") throw new BookingError("bad_request", "Something went wrong with that request. Please try again.");
  const { car, from, to, location } = body;
  const fromTime = body.fromTime || "10:00", toTime = body.toTime || "10:00";
  if (!CARS[car]) throw new BookingError("unknown_car", "That car isn't available to book online.");
  if (!isValidDate(from) || !isValidDate(to)) throw new BookingError("bad_dates", "Choose a pickup and return date.");
  if (from < todayIn(TIMEZONE, now)) throw new BookingError("past_date", "The pickup date has already passed. Choose a new date.");
  const days = daysBetween(from, to);
  if (days < 1) throw new BookingError("bad_range", "The return date needs to be after the pickup date.");
  if (days > MAX_DAYS) throw new BookingError("too_long", `Online bookings can be up to ${MAX_DAYS} days. Text us for longer rentals.`);
  if (!LOCATIONS[location] || LOCATIONS[location].retired) throw new BookingError("bad_location", "Choose a pickup or delivery option.");
  if (!TIMES.includes(fromTime) || !TIMES.includes(toTime)) throw new BookingError("bad_time", "Choose a pickup and return time.");
  return { car, from, to, fromTime, toTime, location, days };
}

/** Each rental day is charged by its weekday: a Thu pickup with a Mon return is Thu (weekday) + Fri, Sat, Sun (weekend).
 *  tripDays is the whole trip's length: long trips on some cars pay the weekday price on weekends (WEEKEND_DEAL). */
export function dayRates(car, from, days, tripDays = days) {
  const r = ratesFor(car, tripDays), weekdayRate = r.weekday, weekendRate = r.weekend; let weekdays = 0, weekends = 0;
  for (let i = 0; i < days; i++) {
    const dow = new Date(Date.parse(from + "T00:00:00Z") + i * 864e5).getUTCDay();
    if (WEEKEND_DAYS.includes(dow)) weekends++; else weekdays++;
  }
  return { weekdays, weekends, weekdayRate, weekendRate, monthly: r.monthly, subtotal: weekdays * weekdayRate + weekends * weekendRate };
}

/** All money in cents. credits: [{ code, label, amount }] (referral discount, Ace Fares credit) come off the
 *  rental after the % discount and before tax, never taking the rental below $1. */
export function quote({ car, location, days, from, credits = [] }) {
  const c = CARS[car], loc = LOCATIONS[location];
  const dr = dayRates(car, from, days);
  const rental = dr.subtotal * 100;
  const d = discountsFor(car).find(x => days >= x.minDays) || null;
  const discount = d ? Math.round(rental * d.pct / 100) : 0;
  let room = Math.max(0, rental - discount - 100);
  const applied = [];
  for (const c of credits || []) {
    const amt = Math.min(Math.max(0, Math.round(c.amount || 0)), room);
    if (amt > 0) { applied.push({ code: c.code, label: c.label, amount: amt }); room -= amt; }
  }
  const credit = applied.reduce((a, c) => a + c.amount, 0);
  const fee = loc.fee * 100;
  const taxPct = days <= TAX.shortMaxDays ? TAX.shortPct : TAX.longPct;
  const taxable = rental - discount - credit + (TAX_INCLUDES_FEES ? fee : 0);
  const tax = Math.round(taxable * taxPct / 100);
  return {
    days, weekdays: dr.weekdays, weekends: dr.weekends, weekdayRate: dr.weekdayRate, weekendRate: dr.weekendRate, monthlyRate: dr.monthly ? dr.monthly.rate : null, rental, discount, discountLabel: d ? `${d.label} (${d.pct}%)` : null, discountPct: d ? d.pct : 0,
    credits: applied, credit, fee, feeLabel: loc.name, taxPct, tax, total: rental - discount - credit + fee + tax,
  };
}
