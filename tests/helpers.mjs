// Test helpers: an in-memory store with ETag behaviour, a local Netlify Blobs
// server, and a fake Stripe that records what the site asks it to do.
import Stripe from "stripe";

export function memoryStore({ delay = 0 } = {}) {
  const m = new Map(); let n = 0;
  const wait = () => delay ? new Promise(r => setTimeout(r, Math.random() * delay)) : Promise.resolve();
  return {
    async getWithMetadata(k) { await wait(); const v = m.get(k); return v ? { data: JSON.parse(v.data), etag: v.etag, metadata: {} } : null; },
    async setJSON(k, data, o = {}) {
      await wait();
      const cur = m.get(k);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = `"${++n}"`; m.set(k, { data: JSON.stringify(data), etag }); return { modified: true, etag };
    },
  };
}

export async function localBlobs() {
  const { BlobsServer } = await import("@netlify/blobs/server");
  const { getStore } = await import("@netlify/blobs");
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const token = "test-token";
  const server = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), "blobs-")), token });
  const { port } = await server.start();
  const store = getStore({ name: "bookings", siteID: "test-site", token, edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, consistency: "strong" });
  return { store, stop: () => server.stop() };
}

export const WEBHOOK_SECRET = "whsec_test_secret";
const real = new Stripe("sk_test_dummy");

export function fakeStripe({ failCreate = false } = {}) {
  const sessions = new Map(), intents = new Map(); let n = 0, k = 0;
  const calls = { create: [], expire: [], piCreate: [], piUpdate: [], piCancel: [] };
  const noSuch = () => { const e = new Error("No such payment_intent"); e.type = "StripeInvalidRequestError"; return e; };
  return {
    calls, sessions, intents,
    paymentIntents: {
      async create(params, opts) {
        calls.piCreate.push({ params, opts });
        if (failCreate) { const e = new Error("Stripe is down"); e.type = "StripeAPIError"; throw e; }
        const id = `pi_test_${++k}`;
        const pi = { id, object: "payment_intent", client_secret: `${id}_secret_abc`, amount: params.amount, amount_received: 0, currency: params.currency,
          status: "requires_payment_method", metadata: { ...params.metadata }, description: params.description, receipt_email: null };
        intents.set(id, pi); return pi;
      },
      async retrieve(id) { const pi = intents.get(id); if (!pi) throw noSuch(); return pi; },
      async update(id, params) { calls.piUpdate.push({ id, params }); const pi = intents.get(id); if (!pi) throw noSuch();
        Object.assign(pi, params, { metadata: { ...pi.metadata, ...(params.metadata || {}) } }); return pi; },
      async cancel(id) { calls.piCancel.push(id); const pi = intents.get(id); if (!pi) throw noSuch(); pi.status = "canceled"; return pi; },
    },
    // simulate the renter paying on the site's checkout page
    payIntent(id, status = "succeeded") { const pi = intents.get(id); pi.status = status; if (status === "succeeded") pi.amount_received = pi.amount; return pi; },
    checkout: { sessions: {
      async create(params, opts) {
        calls.create.push({ params, opts });
        if (failCreate) { const e = new Error("Stripe is down"); e.type = "StripeAPIError"; throw e; }
        const id = `cs_test_${++n}`;
        const amount_total = params.line_items.reduce((a, l) => a + l.price_data.unit_amount * l.quantity, 0);
        const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, metadata: params.metadata, payment_status: "unpaid", status: "open", amount_total, customer_details: null, payment_intent: null };
        sessions.set(id, s); return s;
      },
      async retrieve(id) { const s = sessions.get(id); if (!s) { const e = new Error("No such session"); e.type = "StripeInvalidRequestError"; throw e; } return s; },
      async expire(id) { calls.expire.push(id); const s = sessions.get(id); if (s) s.status = "expired"; return s; },
    } },
    webhooks: real.webhooks,
    // simulate the renter paying
    pay(id) { const s = sessions.get(id); Object.assign(s, { payment_status: "paid", status: "complete", payment_intent: "pi_test_" + id, customer_details: { name: "Test Renter", email: "renter@example.com", phone: "+12145550100" } }); return s; },
  };
}

export function signedEvent(type, object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: "evt_test", type, data: { object } });
  const header = real.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("https://site.test/api/stripe-webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } });
}

export const post = (path, body) => new Request("https://site.test" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
export const get = path => new Request("https://site.test" + path);

// a fixed "now": Oct 12, 2026 at noon in Dallas
export const NOW = Date.parse("2026-10-12T17:00:00Z");
