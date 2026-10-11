import { MIN_GAP_DAYS, HOLD_MINUTES } from "./catalog.mjs";
import { daysBetween, BookingError } from "./pricing.mjs";

// One record per car: { bookings: [...] }. Writes use the record's ETag so two
// renters booking the same car at the same moment can't both succeed.
// A booking: { id, from, to, fromTime, toTime, location, status, expiresAt, sessionId, total, createdAt, customer }
// status: "hold" (in checkout) | "confirmed" (paid) | "released" (checkout cancelled or expired)
//         | "expired" (hold lapsed) | "conflict" (paid after the hold lapsed and the dates were taken: refund needed)
//         | "cancelled" (cancelled by the owner; dates are free again)

const key = car => `car-${car}`;

export function isActive(b, now = Date.now()) {
  return b.status === "confirmed" || (b.status === "hold" && Date.parse(b.expiresAt) > now);
}

export function conflicts(a, b, gap = MIN_GAP_DAYS) {
  // true when the two date ranges are closer than `gap` days apart
  return !(daysBetween(a.to, b.from) >= gap || daysBetween(b.to, a.from) >= gap);
}

export function makeRepo(store, { now = () => Date.now(), retries = 5 } = {}) {
  async function listedEtag(car) {
    const { blobs } = await store.list({ prefix: key(car) });
    const hit = blobs.find(b => b.key === key(car)); return hit ? hit.etag : null;
  }
  async function read(car) {
    for (let i = 0; i < 5; i++) {
      const r = await store.getWithMetadata(key(car), { type: "json" });
      if (!r) return { data: { bookings: [] }, etag: null };
      if (r.etag) return { data: r.data || { bookings: [] }, etag: r.etag };
      // Some environments omit the ETag on reads. Take it from the listing, and only
      // trust it if the record didn't change while we were reading.
      if (!store.list) break;
      const before = await listedEtag(car);
      const again = await store.getWithMetadata(key(car), { type: "json" });
      const after = await listedEtag(car);
      if (again && before && before === after) return { data: again.data || { bookings: [] }, etag: after };
    }
    throw new Error("Storage did not return a stable version tag; refusing an unsafe write");
  }
  async function write(car, data, etag) {
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const res = await store.setJSON(key(car), data, opts);
    return res.modified;
  }
  // read-modify-write with optimistic concurrency
  async function update(car, fn) {
    for (let i = 0; i < retries; i++) {
      const { data, etag } = await read(car);
      const out = fn(data);
      if (out === undefined) return undefined;          // nothing to change
      if (await write(car, data, etag)) return out;
    }
    throw new BookingError("busy", "Lots of people are booking right now. Please try again.", 503);
  }

  return {
    async active(car) {
      const { data } = await read(car);
      return data.bookings.filter(b => isActive(b, now()));
    },
    async hold(car, req, id) {
      return update(car, data => {
        const t = now();
        for (const b of data.bookings) if (b.status === "hold" && !isActive(b, t)) b.status = "expired"; // lapsed holds free their dates
        if (data.bookings.some(b => isActive(b, t) && conflicts(b, req)))
          throw new BookingError("unavailable", "Sorry, those dates were just booked. Please choose different dates.", 409);
        const b = { id, from: req.from, to: req.to, fromTime: req.fromTime, toTime: req.toTime, location: req.location,
          status: "hold", expiresAt: new Date(t + HOLD_MINUTES * 60e3).toISOString(), createdAt: new Date(t).toISOString() };
        data.bookings.push(b);
        return b;
      });
    },
    async attachSession(car, id, sessionId, total) {
      return update(car, data => {
        const b = data.bookings.find(x => x.id === id); if (!b) return undefined;
        b.sessionId = sessionId; b.total = total; return b;
      });
    },
    async confirm(car, id, extra = {}) {
      return update(car, data => {
        const b = data.bookings.find(x => x.id === id);
        if (!b) return undefined;
        if (b.status === "confirmed" || b.status === "conflict") return undefined; // already handled (webhook retries are fine)
        // Paid after the hold had lapsed and someone else took the dates: flag it so the owner refunds
        if (!isActive(b, now()) && data.bookings.some(o => o !== b && isActive(o, now()) && conflicts(o, b))) {
          b.status = "conflict"; b.flaggedAt = new Date(now()).toISOString(); Object.assign(b, extra); return b;
        }
        b.status = "confirmed"; b.confirmedAt = new Date(now()).toISOString(); Object.assign(b, extra);
        return b;
      });
    },
    async release(car, id) {
      return update(car, data => {
        const b = data.bookings.find(x => x.id === id);
        if (!b || (b.status !== "hold" && b.status !== "expired")) return undefined;  // never release a paid booking
        b.status = "released"; b.releasedAt = new Date(now()).toISOString();
        return b;
      });
    },
    async cancel(car, id) {   // owner cancels (refunds are done separately in Stripe)
      return update(car, data => {
        const b = data.bookings.find(x => x.id === id);
        if (!b || b.status === "cancelled" || b.status === "released") return undefined;
        b.previousStatus = b.status; b.status = "cancelled"; b.cancelledAt = new Date(now()).toISOString();
        return b;
      });
    },
    async extendHold(car, id, minutes) {
      return update(car, data => {
        const b = data.bookings.find(x => x.id === id);
        if (!b || b.status !== "hold") return undefined;
        b.expiresAt = new Date(now() + minutes * 60e3).toISOString(); b.pendingPayment = true;
        return b;
      });
    },
    async get(car, id) {
      const { data } = await read(car);
      return data.bookings.find(x => x.id === id) || null;
    },
    async all(car) { return (await read(car)).data.bookings; },
  };
}
