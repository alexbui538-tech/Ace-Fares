import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, validateRequest, todayIn } from "../lib/pricing.mjs";
import { NOW } from "./helpers.mjs";

const v = (o) => validateRequest({ car: "escalade", from: "2026-11-04", to: "2026-11-08", location: "dallas-pickup", ...o }, new Date(NOW));

test("2-day SRX Wed-Thu: weekday rate $49, no discount, 10% tax", () => {
  const q = quote(v({ car: "srx", to: "2026-11-06" }));   // Nov 4 2026 is a Wednesday
  assert.equal(q.days, 2); assert.equal(q.weekdays, 2); assert.equal(q.rental, 9800); assert.equal(q.discount, 0);
  assert.equal(q.tax, 980); assert.equal(q.total, 10780);
});

test("4-day Escalade Wed-Sat with delivery: 2 x $259 + 2 x $349, 5% off (Escalade 3+ days), fee taxed", () => {
  const q = quote(v({ location: "dallas-delivery" }));
  assert.equal(q.weekdays, 2); assert.equal(q.weekends, 2);
  assert.equal(q.rental, 121600); assert.equal(q.discount, 6080); assert.equal(q.fee, 10000);
  assert.equal(q.tax, 12552); assert.equal(q.total, 138072);
});

test("weekend rates: Fri, Sat and Sun are weekend days; the return day isn't charged", () => {
  // Thu Nov 5 pickup, Mon Nov 9 return = Thu + Fri + Sat + Sun
  const e = quote(v({ from: "2026-11-05", to: "2026-11-09" }));
  assert.equal(e.weekdays, 1); assert.equal(e.weekends, 3); assert.equal(e.rental, (259 + 3 * 349) * 100);
  const b = quote(v({ car: "bmw", from: "2026-11-06", to: "2026-11-08" }));   // Fri + Sat
  assert.equal(b.rental, 2 * 199 * 100);
  const s = quote(v({ car: "srx", from: "2026-11-08", to: "2026-11-10" }));   // Sun + Mon
  assert.equal(s.rental, (69 + 49) * 100);
  const vn = quote(v({ car: "van", from: "2026-11-06", to: "2026-11-09" }));  // Fri, Sat, Sun at the van weekend rate
  assert.equal(vn.rental, 3 * 129 * 100);
  assert.equal(quote(v({ car: "van", from: "2026-11-09", to: "2026-11-11" })).rental, 2 * 89 * 100);   // Mon + Tue
});

test("DFW airport handoff is no longer offered; delivery is $100", () => {
  assert.throws(() => validateRequest({ car: "srx", from: "2027-01-04", to: "2027-01-06", location: "dfw" }, new Date("2026-10-14T12:00:00Z")), /pickup or delivery option/);
  assert.equal(quote(v({ location: "dallas-delivery" })).fee, 10000);
});

test("30 days: Odyssey monthly discount is 40%, still 10% tax", () => {
  const q = quote(v({ car: "van", from: "2026-11-01", to: "2026-12-01" }));
  assert.equal(q.days, 30); assert.equal(q.discountPct, 40); assert.equal(q.taxPct, 10);
  // Nov 2026: 17 Mon-Thu days at $89 + 13 Fri-Sun days at $129 = $3,190
  assert.equal(q.weekdays, 17); assert.equal(q.weekends, 13);
  assert.equal(q.rental, 319000); assert.equal(q.discount, 127600); assert.equal(q.tax, 19140); assert.equal(q.total, 210540);
});

test("31 days: 6.25% tax", () => {
  const q = quote(v({ car: "van", from: "2026-11-01", to: "2026-12-02" }));
  assert.equal(q.taxPct, 6.25); assert.equal(q.rental, 327900); assert.equal(q.tax, Math.round((327900 - 131160) * 0.0625));
});

test("rejects bad requests with clear messages", () => {
  for (const [o, code] of [
    [{ car: "tesla" }, "unknown_car"], [{ from: "2026-10-01" }, "past_date"], [{ to: "2026-11-04" }, "bad_range"],
    [{ to: "2027-06-01" }, "too_long"], [{ location: "mars" }, "bad_location"], [{ from: "2026-02-30" }, "bad_dates"],
    [{ fromTime: "03:00" }, "bad_time"],
  ]) assert.throws(() => v(o), e => e.code === code, code);
});

test("today is computed in Dallas time", () => {
  // 11pm Dallas on Oct 12 is already Oct 13 in UTC
  assert.equal(todayIn("America/Chicago", new Date("2026-10-13T04:00:00Z")), "2026-10-12");
});

test("referral discount and Ace Fares credit come off the rental before tax, never below $1", () => {
  const base = v({ car: "srx", from: "2026-11-09", to: "2026-11-11" });           // Mon + Tue = $98
  const q = quote({ ...base, credits: [{ code: "welcome", label: "Friend referral: first trip", amount: 5000 }] });
  assert.equal(q.credit, 5000); assert.equal(q.tax, Math.round((9800 - 5000) * 0.10)); assert.equal(q.total, 9800 - 5000 + q.tax);
  const big = quote({ ...base, credits: [{ code: "welcome", label: "w", amount: 5000 }, { code: "credit", label: "c", amount: 10000 }] });
  assert.deepEqual(big.credits.map(c => c.amount), [5000, 4700]);               // rental can't go below $1
  assert.equal(big.total, 100 + Math.round(100 * 0.10));
  assert.equal(quote(base).credit, 0);
});

test("each car has its own discounts for longer trips", () => {
  const pct = (car, from, to) => quote(v({ car, from, to })).discountPct;
  // Escalade 5% / 15% / 30%
  assert.equal(pct("escalade", "2026-11-02", "2026-11-04"), 0); assert.equal(pct("escalade", "2026-11-02", "2026-11-05"), 5);
  assert.equal(pct("escalade", "2026-11-02", "2026-11-09"), 15); assert.equal(pct("escalade", "2026-11-02", "2026-12-02"), 30);
  // SRX 15% / 25% / 45%
  assert.equal(pct("srx", "2026-11-02", "2026-11-05"), 15); assert.equal(pct("srx", "2026-11-02", "2026-11-09"), 25); assert.equal(pct("srx", "2026-11-02", "2026-12-02"), 45);
  // Odyssey 10% / 20% / 40%
  assert.equal(pct("van", "2026-11-02", "2026-11-05"), 10); assert.equal(pct("van", "2026-11-02", "2026-11-09"), 20); assert.equal(pct("van", "2026-11-02", "2026-12-02"), 40);
  // BMW: 10% for 3+ days, no weekly or monthly discount
  assert.equal(pct("bmw", "2026-11-02", "2026-11-05"), 10); assert.equal(pct("bmw", "2026-11-02", "2026-11-09"), 10); assert.equal(pct("bmw", "2026-11-02", "2026-12-02"), 10);
  assert.equal(quote(v({ car: "escalade", from: "2026-11-02", to: "2026-11-09" })).discountLabel, "Weekly discount (15%)");
});
