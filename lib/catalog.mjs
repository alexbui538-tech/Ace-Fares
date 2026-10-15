// Server-side source of truth for prices, fees, discounts and tax.
// The website shows the same numbers, but checkout always charges what is here.
// tests/catalog-matches-site.test.mjs fails if public/index.html drifts from this file.

// weekday = Monday-Thursday, weekend = Friday-Sunday (per rental day; see dayRate in pricing.mjs)
// extraMile = $ per mile over the included miles (rental agreement section 8)
export const CARS = {
  escalade: { name: "2021 Cadillac Escalade",      weekday: 259, weekend: 349, miles: 100, extraMile: 3,    photo: "escalade-1", rating: 4.8, trips: 14 },
  srx:      { name: "Cadillac SRX",                weekday: 39,  weekend: 69,  miles: 200, extraMile: 0.99, photo: "srx-1",      rating: null, trips: 0 },
  bmw:      { name: "BMW 650i xDrive Convertible", weekday: 139, weekend: 199, miles: 100, extraMile: 0.99, photo: "bmw-1",      rating: null, trips: 0 },
  van:      { name: "2019 Honda Odyssey EX-L",     weekday: 89,  weekend: 129, miles: 200, extraMile: 0.99, photo: "van-1",      rating: null, trips: 0 },
};
// Refundable security deposit, in dollars, per car. It is a temporary authorization hold on the
// renter's card through Stripe, not a charge. Set from typical Dallas-area deposits for each class:
// standard SUVs/vans $200-300, premium/luxury $500 and up.
export const DEPOSITS = { escalade: 750, srx: 250, bmw: 500, van: 250 };
export const SMOKING_FEE = 150;          // flat smoking/vaping remediation fee (dollars), rental agreement section 12
export const DEPOSIT_LEAD_HOURS = 24;    // hold goes on 24h before pickup, or right after payment if pickup is sooner
export const DEPOSIT_RELEASE_HOURS = 72; // released automatically 72h after the scheduled return unless the owner keeps it
export const DEPOSIT_RENEW_HOURS = 12;   // a hold that will expire within this window while still needed is renewed

export const WEEKEND_DAYS = [5, 6, 0];   // Fri, Sat, Sun (0 = Sunday)

/** "Dallas pickup, 2204 Lovedale Avenue, Dallas, TX" (name plus street address when there is one) */
export const placeText = id => { const l = LOCATIONS[id]; return !l ? (id || "") : l.address ? `${l.name}, ${l.address}` : l.name; };
export const LOCATIONS = {
  "dallas-pickup":   { name: "Dallas pickup", address: "2204 Lovedale Avenue, Dallas, TX", fee: 0 },
  "dallas-delivery": { name: "Delivery",                  fee: 100 },
  "dfw":             { name: "DFW International Airport", fee: 125, retired: true },   // no longer offered; kept so older bookings still display
};

// Discounts for longer trips, per car. The largest one that applies is used, on the rental price only (not fees).
// public/index.html has the same numbers on each car (tests/catalog-matches-site.test.mjs checks they match).
const tier = (minDays, pct) => ({ minDays, pct, label: minDays >= 30 ? "Monthly discount" : minDays >= 7 ? "Weekly discount" : `${minDays}+ day discount` });
export const CAR_DISCOUNTS = {
  escalade: [tier(30, 30), tier(7, 15), tier(3, 5)],   // monthly: 30% off the $200 monthly price (MONTHLY_RATE)
  srx:      [tier(30, 45), tier(7, 25), tier(3, 15)],
  bmw:      [tier(3, 10)],                       // no weekly or monthly discount
  van:      [tier(30, 40), tier(7, 20), tier(3, 10)],
};
export const DISCOUNTS = [tier(30, 25), tier(3, 10)];   // fallback for a car without its own list
export const discountsFor = car => CAR_DISCOUNTS[car] || DISCOUNTS;

// Trips this many days or longer pay the weekday price on Fri-Sun too (the BMW always pays weekend prices).
// public/index.html has the same number on each car as weekendDeal (tests/catalog-matches-site.test.mjs checks).
export const WEEKEND_DEAL = { escalade: 7, srx: 7, van: 7 };
export const weekendRateFor = (car, tripDays) => WEEKEND_DEAL[car] && tripDays >= WEEKEND_DEAL[car] ? CARS[car].weekday : CARS[car].weekend;

// Trips this long pay one flat daily price every day of the week; the car's monthly % discount then comes off that.
// public/index.html has the same on the car as monthly:{minDays,rate} (tests/catalog-matches-site.test.mjs checks).
export const MONTHLY_RATE = { escalade: { minDays: 30, rate: 200 } };
export const monthlyFor = (car, tripDays) => { const m = MONTHLY_RATE[car]; return m && tripDays >= m.minDays ? m : null; };
/** Daily prices for a trip of this length: { weekday, weekend, monthly } */
export const ratesFor = (car, tripDays) => { const m = monthlyFor(car, tripDays); return m ? { weekday: m.rate, weekend: m.rate, monthly: m } : { weekday: CARS[car].weekday, weekend: weekendRateFor(car, tripDays), monthly: null }; };

// Texas motor vehicle gross rental receipts tax (Texas Comptroller):
// 10% for rentals of 1-30 days, 6.25% for 31-180 days, after discounts.
// TAX_INCLUDES_FEES: whether delivery/airport fees are taxed too. Confirm with your accountant.
export const TAX = { shortPct: 10, longPct: 6.25, shortMaxDays: 30, label: "Texas motor vehicle rental tax" };
export const TAX_INCLUDES_FEES = true;

export const MAX_DAYS = 180;          // longest rental bookable online
export const MIN_GAP_DAYS = 1;        // a car returned on the 10th can go out again on the 11th
export const HOLD_MINUTES = 35;       // dates are held this long while the renter is in Stripe checkout
export const CHECKOUT_MINUTES = 31;   // Stripe requires at least 30 minutes; 31 leaves a margin
export const TIMEZONE = "America/Chicago";

export const TIMES = (() => { const t = []; for (let m = 6 * 60; m <= 22 * 60; m += 30) t.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 ? "30" : "00"}`); return t; })();

// Driver identity check (Stripe Identity), see lib/identity.mjs
export const MIN_AGE = 18;                     // also in the rental agreement (POLICY.minAge)
export const IDENTITY_KEEP_DAYS = 90;          // Stripe deletes license images + face data this long after the return
export const IDENTITY_KEEP_DAYS_CANCELLED = 30; // ...or this long after a cancellation (Texas requires within one year)

// Refer a friend (lib/referrals.mjs): amounts in cents
export const REFERRAL = { reward: 10000, friendDiscount: 5000, minDays: 3 };   // $100 credit to the referrer, $50 off the friend's first trip, trips of 3+ days
export const IDENTITY_DUE_MINUTES = 60;        // renters must finish the license + selfie check within an hour of booking

// Trip extensions (lib/trips.mjs): renters ask in My trips, the owner approves on the bookings page
export const EXTENSION_DAILY_FEE = 25;         // $ per extra day, on top of that day's normal rate (plus tax)
export const REVIEW_REQUEST_HOURS = 2;         // review request email goes out this long after the scheduled return

// Prices and deposits can be changed on the bookings page. The values above are the defaults; changes are kept in
// "config-prices" in the bookings store and applied to CARS / DEPOSITS here at the start of each request.
export const PRICE_DEFAULTS = {
  cars: Object.fromEntries(Object.entries(CARS).map(([k, c]) => [k, { weekday: c.weekday, weekend: c.weekend }])),
  deposits: { ...DEPOSITS },
};
let pricesLoadedAt = -Infinity;
export async function loadPriceOverrides(store, { force = false, now = Date.now() } = {}) {
  if (!store || (!force && now - pricesLoadedAt < 30e3)) return;
  pricesLoadedAt = now;
  let o = {};
  try { const r = await store.getWithMetadata("config-prices", { type: "json" }); o = (r && r.data) || {}; } catch { return; }
  applyPrices(o);
}
export function applyPrices(o = {}) {
  for (const k of Object.keys(CARS)) {
    const d = PRICE_DEFAULTS.cars[k], x = (o.cars || {})[k] || {};
    CARS[k].weekday = Number.isFinite(x.weekday) ? x.weekday : d.weekday;
    CARS[k].weekend = Number.isFinite(x.weekend) ? x.weekend : d.weekend;
    const dep = (o.deposits || {})[k];
    DEPOSITS[k] = Number.isFinite(dep) ? dep : PRICE_DEFAULTS.deposits[k];
  }
}
export const currentPrices = () => ({
  cars: Object.fromEntries(Object.entries(CARS).map(([k, c]) => [k, { weekday: c.weekday, weekend: c.weekend }])),
  deposits: { ...DEPOSITS }, defaults: PRICE_DEFAULTS,
});
