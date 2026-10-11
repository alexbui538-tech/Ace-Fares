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

test("4-day Escalade Wed-Sat with delivery: 2 x $250 + 2 x $350, 10% off, fee taxed", () => {
  const q = quote(v({ location: "dallas-delivery" }));
  assert.equal(q.weekdays, 2); assert.equal(q.weekends, 2);
  assert.equal(q.rental, 120000); assert.equal(q.discount, 12000); assert.equal(q.fee, 10000);
  assert.equal(q.tax, 11800); assert.equal(q.total, 129800);
});

test("weekend rates: Fri, Sat and Sun are weekend days; the return day isn't charged", () => {
  // Thu Nov 5 pickup, Mon Nov 9 return = Thu + Fri + Sat + Sun
  const e = quote(v({ from: "2026-11-05", to: "2026-11-09" }));
  assert.equal(e.weekdays, 1); assert.equal(e.weekends, 3); assert.equal(e.rental, (250 + 3 * 350) * 100);
  const b = quote(v({ car: "bmw", from: "2026-11-06", to: "2026-11-08" }));   // Fri + Sat
  assert.equal(b.rental, 2 * 200 * 100);
  const s = quote(v({ car: "srx", from: "2026-11-08", to: "2026-11-10" }));   // Sun + Mon
  assert.equal(s.rental, (69 + 49) * 100);
  const vn = quote(v({ car: "van", from: "2026-11-06", to: "2026-11-09" }));  // van is $59 every day
  assert.equal(vn.rental, 3 * 59 * 100);
});

test("DFW airport fee is $125", () => {
  assert.equal(quote(v({ location: "dfw" })).fee, 12500);
});

test("30 days: 25% monthly discount, still 10% tax", () => {
  const q = quote(v({ car: "van", from: "2026-11-01", to: "2026-12-01" }));
  assert.equal(q.days, 30); assert.equal(q.discountPct, 25); assert.equal(q.taxPct, 10);
  assert.equal(q.rental, 177000); assert.equal(q.discount, 44250); assert.equal(q.tax, 13275); assert.equal(q.total, 146025);
});

test("31 days: 6.25% tax", () => {
  const q = quote(v({ car: "van", from: "2026-11-01", to: "2026-12-02" }));
  assert.equal(q.taxPct, 6.25); assert.equal(q.tax, Math.round((182900 - 45725) * 0.0625));
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
