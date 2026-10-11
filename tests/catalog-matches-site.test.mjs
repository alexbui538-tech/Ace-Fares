// The page shows prices; the server charges them. This fails if they ever disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CARS, LOCATIONS, DISCOUNTS, TAX, TAX_INCLUDES_FEES } from "../lib/catalog.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("car prices and miles on the page match the server", () => {
  for (const [id, c] of Object.entries(CARS)) {
    const m = html.match(new RegExp(`id:"${id}"[^\\n]*?price:(\\d+), miles:(\\d+)`));
    assert.ok(m, `car ${id} found on page`);
    assert.equal(Number(m[1]), c.price, `${id} price`); assert.equal(Number(m[2]), c.miles, `${id} miles`);
  }
});

test("pickup/delivery fees on the page match the server", () => {
  for (const [id, l] of Object.entries(LOCATIONS)) {
    const m = html.match(new RegExp(`id:"${id}",[^\\n]*?fee:(\\d+)`));
    assert.ok(m, `location ${id} found on page`); assert.equal(Number(m[1]), l.fee, `${id} fee`);
  }
});

test("discounts and tax on the page match the server", () => {
  for (const d of DISCOUNTS) assert.ok(html.includes(`{ minDays:${d.minDays}, pct:${d.pct},`), `discount ${d.minDays}+ days ${d.pct}%`);
  assert.ok(html.includes(`tax: { shortPct: ${TAX.shortPct}, longPct: ${TAX.longPct}, shortMaxDays: ${TAX.shortMaxDays}, includesFees: ${TAX_INCLUDES_FEES} }`), "tax settings");
});

test("no secret keys in the website files", () => {
  assert.doesNotMatch(html, /sk_(test|live)_|whsec_|rk_(test|live)_/);
});
