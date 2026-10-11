import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, conflicts } from "../lib/bookings.mjs";
import { memoryStore, NOW } from "./helpers.mjs";

const r = (from, to) => ({ from, to, fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" });

test("1-day turnaround: returned on the 10th, next pickup on the 11th is fine, the 10th is not", () => {
  const a = r("2026-11-05", "2026-11-10");
  assert.equal(conflicts(a, r("2026-11-11", "2026-11-13")), false);
  assert.equal(conflicts(a, r("2026-11-10", "2026-11-13")), true);
  assert.equal(conflicts(a, r("2026-11-01", "2026-11-04")), false);
  assert.equal(conflicts(a, r("2026-11-01", "2026-11-05")), true);
  assert.equal(conflicts(a, r("2026-11-06", "2026-11-07")), true);
});

test("a held date range blocks others; a different car is unaffected", async () => {
  const repo = makeRepo(memoryStore(), { now: () => NOW });
  await repo.hold("escalade", r("2026-11-05", "2026-11-10"), "a");
  await assert.rejects(repo.hold("escalade", r("2026-11-08", "2026-11-12"), "b"), e => e.status === 409);
  await repo.hold("srx", r("2026-11-08", "2026-11-12"), "c");
  assert.equal((await repo.active("escalade")).length, 1);
});

test("a hold expires after 35 minutes and frees the dates", async () => {
  let t = NOW; const repo = makeRepo(memoryStore(), { now: () => t });
  await repo.hold("bmw", r("2026-11-05", "2026-11-10"), "a");
  t += 36 * 60e3;
  assert.equal((await repo.active("bmw")).length, 0);
  await repo.hold("bmw", r("2026-11-05", "2026-11-10"), "b");
  assert.equal((await repo.get("bmw", "a")).status, "expired");
});

test("released holds free the dates; confirmed bookings can't be released", async () => {
  const repo = makeRepo(memoryStore(), { now: () => NOW });
  await repo.hold("van", r("2026-11-05", "2026-11-10"), "a");
  await repo.release("van", "a");
  await repo.hold("van", r("2026-11-05", "2026-11-10"), "b");
  await repo.confirm("van", "b");
  await repo.release("van", "b");
  assert.equal((await repo.get("van", "b")).status, "confirmed");
});

test("paid after the hold lapsed and someone else took the dates: flagged as conflict", async () => {
  let t = NOW; const repo = makeRepo(memoryStore(), { now: () => t });
  await repo.hold("srx", r("2026-11-05", "2026-11-10"), "late");
  t += 40 * 60e3;
  await repo.hold("srx", r("2026-11-06", "2026-11-08"), "other");
  const b = await repo.confirm("srx", "late");
  assert.equal(b.status, "conflict");
});

test("two renters booking the same dates at the same moment: exactly one wins", async () => {
  for (let round = 0; round < 20; round++) {
    const repo = makeRepo(memoryStore({ delay: 5 }), { now: () => NOW, retries: 50 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => repo.hold("escalade", r("2026-11-05", "2026-11-10"), "p" + i)));
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1, `round ${round}`);
    assert.equal((await repo.active("escalade")).length, 1);
  }
});
