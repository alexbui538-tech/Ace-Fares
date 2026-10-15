// The page shows prices; the server charges them. This fails if they ever disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CARS, LOCATIONS, CAR_DISCOUNTS, WEEKEND_DEAL, MONTHLY_RATE, TAX, TAX_INCLUDES_FEES } from "../lib/catalog.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("car prices and miles on the page match the server", () => {
  for (const [id, c] of Object.entries(CARS)) {
    const m = html.match(new RegExp(`id:"${id}"[^\\n]*?weekday:(\\d+), weekend:(\\d+), miles:(\\d+)`));
    assert.ok(m, `car ${id} found on page`);
    assert.equal(Number(m[1]), c.weekday, `${id} weekday price`); assert.equal(Number(m[2]), c.weekend, `${id} weekend price`);
    assert.equal(Number(m[3]), c.miles, `${id} miles`);
  }
});

test("pickup/delivery fees on the page match the server", () => {
  for (const [id, l] of Object.entries(LOCATIONS)) {
    if (l.retired) { assert.ok(!html.includes(`id:"${id}"`), `${id} is no longer offered on the page`); continue; }
    const m = html.match(new RegExp(`id:"${id}",[^\\n]*?fee:(\\d+)`));
    assert.ok(m, `location ${id} found on page`); assert.equal(Number(m[1]), l.fee, `${id} fee`);
  }
});

test("discounts and tax on the page match the server", () => {
  for (const [id, list] of Object.entries(CAR_DISCOUNTS)) {
    const m = html.match(new RegExp(`id:"${id}"[^\\n]*?discounts:(\\[[^\\]]*\\])`));
    assert.ok(m, `discounts for ${id} on the page`);
    const page = JSON.parse(m[1].replace(/(\w+):/g, '"$1":'));
    assert.deepEqual(page.map(d => [d.minDays, d.pct]).sort((a, b) => b[0] - a[0]), list.map(d => [d.minDays, d.pct]), `${id} discounts`);
  }
  assert.ok(html.includes(`tax: { shortPct: ${TAX.shortPct}, longPct: ${TAX.longPct}, shortMaxDays: ${TAX.shortMaxDays}, includesFees: ${TAX_INCLUDES_FEES} }`), "tax settings");
});

test("weekends-at-weekday-price trip lengths on the page match the server", () => {
  for (const id of Object.keys(CARS)) {
    const m = html.match(new RegExp(`id:"${id}"[^\\n]*?weekendDeal:(\\d+)`)), line = html.match(new RegExp(`id:"${id}"[^\\n]*`))[0];
    if (WEEKEND_DEAL[id]) { assert.ok(m, `${id} weekendDeal on the page`); assert.equal(Number(m[1]), WEEKEND_DEAL[id], `${id} weekendDeal`); }
    else assert.ok(!line.includes("weekendDeal"), `${id} has no weekend deal`);
  }
});

test("monthly flat prices on the page match the server", () => {
  for (const id of Object.keys(CARS)) {
    const line = html.match(new RegExp(`id:"${id}"[^\\n]*`))[0], m = line.match(/monthly:\{minDays:(\d+),rate:(\d+)\}/);
    if (MONTHLY_RATE[id]) { assert.ok(m, `${id} monthly on the page`); assert.deepEqual([Number(m[1]), Number(m[2])], [MONTHLY_RATE[id].minDays, MONTHLY_RATE[id].rate], `${id} monthly`); }
    else assert.ok(!m, `${id} has no monthly price`);
  }
});

test("no secret keys in the website files", () => {
  assert.doesNotMatch(html, /sk_(test|live)_|whsec_|rk_(test|live)_/);
});
