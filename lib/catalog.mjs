// Server-side source of truth for prices, fees, discounts and tax.
// The website shows the same numbers, but checkout always charges what is here.
// tests/catalog-matches-site.test.mjs fails if public/index.html drifts from this file.

export const CARS = {
  escalade: { name: "2021 Cadillac Escalade", price: 400, miles: 100 },
  srx:      { name: "Cadillac SRX",           price: 59,  miles: 200 },
  bmw:      { name: "BMW 650i xDrive Convertible", price: 350, miles: 100 },
  van:      { name: "2019 Honda Odyssey EX-L", price: 59,  miles: 200 },
};

export const LOCATIONS = {
  "dallas-pickup":   { name: "Dallas pickup",             fee: 0 },
  "dallas-delivery": { name: "Delivery",                  fee: 100 },
  "dfw":             { name: "DFW International Airport", fee: 125 },
};

// Largest discount that applies is used. Applied to the rental price only.
export const DISCOUNTS = [
  { minDays: 30, pct: 25, label: "Monthly discount" },
  { minDays: 3,  pct: 10, label: "3+ day discount" },
];

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
