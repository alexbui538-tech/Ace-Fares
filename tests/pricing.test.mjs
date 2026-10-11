import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, validateRequest, todayIn } from "../lib/pricing.mjs";
import { NOW } from "./helpers.mjs";

const v = (o) => validateRequest({ car: "escalade", from: "2026-11-04", to: "2026-11-08", location: "dallas-pickup", ...o }, new Date(NOW));

test("2-day rental: no discount, 10% tax", () => {
  const q = quote(v({ car: "srx", to: "2026-11-06" }));
  assert.equal(q.days, 2); assert.equal(q.rental, 11800); assert.equal(q.discount, 0);
  assert.equal(q.tax, 1180); assert.equal(q.total, 12980);
});

test("4-day Escalade with delivery: 10% off rental, fee taxed, 10% tax", () => {
  const q = quote(v({ location: "dallas-delivery" }));
  assert.equal(q.rental, 160000); assert.equal(q.discount, 16000); assert.equal(q.fee, 10000);
  assert.equal(q.tax, 15400); assert.equal(q.total, 169400);
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
