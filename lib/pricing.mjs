import { CARS, LOCATIONS, DISCOUNTS, TAX, TAX_INCLUDES_FEES, MAX_DAYS, TIMES, TIMEZONE, WEEKEND_DAYS } from "./catalog.mjs";

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
  if (!LOCATIONS[location]) throw new BookingError("bad_location", "Choose a pickup or delivery option.");
  if (!TIMES.includes(fromTime) || !TIMES.includes(toTime)) throw new BookingError("bad_time", "Choose a pickup and return time.");
  return { car, from, to, fromTime, toTime, location, days };
}

/** Each rental day is charged by its weekday: a Thu pickup with a Mon return is Thu (weekday) + Fri, Sat, Sun (weekend). */
export function dayRates(car, from, days) {
  const c = CARS[car]; let weekdays = 0, weekends = 0;
  for (let i = 0; i < days; i++) {
    const dow = new Date(Date.parse(from + "T00:00:00Z") + i * 864e5).getUTCDay();
    if (WEEKEND_DAYS.includes(dow)) weekends++; else weekdays++;
  }
  return { weekdays, weekends, subtotal: weekdays * c.weekday + weekends * c.weekend };
}

/** All money in cents. */
export function quote({ car, location, days, from }) {
  const c = CARS[car], loc = LOCATIONS[location];
  const dr = dayRates(car, from, days);
  const rental = dr.subtotal * 100;
  const d = DISCOUNTS.find(x => days >= x.minDays) || null;
  const discount = d ? Math.round(rental * d.pct / 100) : 0;
  const fee = loc.fee * 100;
  const taxPct = days <= TAX.shortMaxDays ? TAX.shortPct : TAX.longPct;
  const taxable = rental - discount + (TAX_INCLUDES_FEES ? fee : 0);
  const tax = Math.round(taxable * taxPct / 100);
  return {
    days, weekdays: dr.weekdays, weekends: dr.weekends, weekdayRate: c.weekday, weekendRate: c.weekend, rental, discount, discountLabel: d ? `${d.label} (${d.pct}%)` : null, discountPct: d ? d.pct : 0,
    fee, feeLabel: loc.name, taxPct, tax, total: rental - discount + fee + tax,
  };
}
