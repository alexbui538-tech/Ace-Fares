// Test helpers: an in-memory store with ETag behaviour, a local Netlify Blobs
// server, and a fake Stripe that records what the site asks it to do.
import Stripe from "stripe";

export function memoryStore({ delay = 0 } = {}) {
  const m = new Map(); let n = 0;
  const wait = () => delay ? new Promise(r => setTimeout(r, Math.random() * delay)) : Promise.resolve();
  return {
    async getWithMetadata(k, o = {}) { await wait(); const v = m.get(k); if (!v) return null;
      return o.type === "arrayBuffer" ? { data: v.raw, etag: v.etag, metadata: v.metadata || {} } : { data: JSON.parse(v.data), etag: v.etag, metadata: v.metadata || {} }; },
    async set(k, data, o = {}) { await wait(); const etag = `"${++n}"`; m.set(k, { raw: data, data: "null", etag, metadata: o.metadata || {} }); return { modified: true, etag }; },
    keys: () => [...m.keys()],
    async setJSON(k, data, o = {}) {
      await wait();
      const cur = m.get(k);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = `"${++n}"`; m.set(k, { data: JSON.stringify(data), etag }); return { modified: true, etag };
    },
    async delete(k) { m.delete(k); },
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

export function fakeStripe({ failCreate = false, declineHolds = false, clock = () => Date.now() } = {}) {
  const sessions = new Map(), intents = new Map(), customers = new Map(); let n = 0, k = 0, cu = 0;
  const calls = { create: [], expire: [], piCreate: [], piUpdate: [], piCancel: [], piCapture: [], cusCreate: [], cusUpdate: [], vsCreate: [], vsRetrieve: [], vsCancel: [], vsRedact: [] };
  const fake = { declineHolds };
  const noSuch = () => { const e = new Error("No such payment_intent"); e.type = "StripeInvalidRequestError"; return e; };
  return {
    calls, sessions, intents,
    paymentIntents: {
      async create(params, opts) {
        calls.piCreate.push({ params, opts });
        if (failCreate) { const e = new Error("Stripe is down"); e.type = "StripeAPIError"; throw e; }
        if (opts && opts.idempotencyKey) { for (const p of intents.values()) if (p._key === opts.idempotencyKey) return p; }
        const id = `pi_test_${++k}`;
        const pi = { id, object: "payment_intent", client_secret: `${id}_secret_abc`, amount: params.amount, amount_received: 0, amount_capturable: 0, currency: params.currency,
          status: "requires_payment_method", metadata: { ...params.metadata }, description: params.description, receipt_email: null,
          customer: params.customer || null, payment_method: params.payment_method || null, capture_method: params.capture_method || "automatic",
          setup_future_usage: params.setup_future_usage || null, _key: opts && opts.idempotencyKey };
        intents.set(id, pi);
        if (params.confirm && params.capture_method === "manual") {
          if (fake.declineHolds) { const e = new Error("Your card was declined."); e.type = "StripeCardError"; e.code = "card_declined"; pi.status = "requires_payment_method"; throw e; }
          pi.status = "requires_capture"; pi.amount_capturable = pi.amount;
          pi.latest_charge = { id: "ch_" + id, payment_method_details: { card: { capture_before: Math.floor(clock() / 1000) + 7 * 86400, extended_authorization: { status: "disabled" } } } };
        }
        return pi;
      },
      async retrieve(id) { const pi = intents.get(id); if (!pi) throw noSuch(); return pi; },
      async update(id, params) { calls.piUpdate.push({ id, params }); const pi = intents.get(id); if (!pi) throw noSuch();
        Object.assign(pi, params, { metadata: { ...pi.metadata, ...(params.metadata || {}) } }); return pi; },
      async cancel(id) { calls.piCancel.push(id); const pi = intents.get(id); if (!pi) throw noSuch(); pi.status = "canceled"; return pi; },
      async capture(id, params = {}) { calls.piCapture.push({ id, params }); const pi = intents.get(id); if (!pi) throw noSuch();
        if (pi.status !== "requires_capture") { const e = new Error("This PaymentIntent could not be captured"); e.type = "StripeInvalidRequestError"; throw e; }
        pi.status = "succeeded"; pi.amount_received = params.amount_to_capture ?? pi.amount; return pi; },
    },
    identity: { verificationSessions: (() => {
      const vs = new Map(); let v = 0;
      const noVs = () => { const e = new Error("No such verification session"); e.type = "StripeInvalidRequestError"; return e; };
      const api = {
        all: vs,
        async create(params, opts) { calls.vsCreate.push({ params, opts });
          if (fake.identityOff) { const e = new Error("Your account is not activated for Identity"); e.type = "StripeInvalidRequestError"; throw e; }
          const id = `vs_test_${++v}`; const s = { id, object: "identity.verification_session", status: "requires_input", client_secret: `${id}_secret_xyz`,
            url: `https://verify.stripe.com/start/${id}`, metadata: { ...params.metadata }, last_error: null, verified_outputs: null, last_verification_report: null };
          vs.set(id, s); return s; },
        async retrieve(id, opts) { calls.vsRetrieve.push({ id, opts }); const s = vs.get(id); if (!s) throw noVs(); return { ...s }; },
        async cancel(id) { calls.vsCancel.push(id); const s = vs.get(id); if (!s) throw noVs(); s.status = "canceled"; return s; },
        async redact(id) { calls.vsRedact.push(id); const s = vs.get(id); if (!s) throw noVs(); s.redacted = true; s.verified_outputs = null; return s; },
      };
      return api; })() },
    // simulate the renter finishing Stripe's license + selfie screens
    finishIdentity(id, { result = "verified", first = "Jordan", last = "Lee", dob = { day: 4, month: 6, year: 1990 }, expires = { day: 1, month: 1, year: 2030 }, error = "document_expired" } = {}) {
      const s = this.identity.verificationSessions.all.get(id);
      if (result === "verified") Object.assign(s, { status: "verified", last_error: null,
        verified_outputs: { first_name: first, last_name: last, dob }, last_verification_report: { id: "vr_1", document: { expiration_date: expires, type: "driving_license" } } });
      else Object.assign(s, { status: "requires_input", last_error: { code: error, reason: "The document is expired." } });
      return { ...s };
    },
    customers: {
      async create(params) { calls.cusCreate.push(params); const id = `cus_test_${++cu}`; const c = { id, ...params }; customers.set(id, c); return c; },
      async update(id, params) { calls.cusUpdate.push({ id, params }); const c = customers.get(id); Object.assign(c, params); return c; },
    },
    // simulate the renter paying on the site's checkout page
    payIntent(id, status = "succeeded") { const pi = intents.get(id); pi.status = status; pi.payment_method = pi.payment_method || "pm_test_visa";
      if (status === "succeeded") pi.amount_received = pi.amount; return pi; },
    fake,
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
    pay(id) { const s = sessions.get(id);
      const pid = "pi_hosted_" + id; intents.set(pid, { id: pid, status: "succeeded", amount: s.amount_total, amount_received: s.amount_total, customer: "cus_hosted_" + id, payment_method: "pm_test_visa", metadata: { ...s.metadata } });
      Object.assign(s, { payment_status: "paid", status: "complete", payment_intent: pid, customer: "cus_hosted_" + id, customer_details: { name: "Test Renter", email: "renter@example.com", phone: "+12145550100" } }); return s; },
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
