// Small JSON key-value helpers on Netlify Blobs with optimistic concurrency (ETags),
// the same approach lib/bookings.mjs uses for the booking records.

async function listedEtag(store, key) {
  const { blobs } = await store.list({ prefix: key });
  const hit = blobs.find(b => b.key === key); return hit ? hit.etag : null;
}

/** { data, etag } or { data: null, etag: null } when the key doesn't exist */
export async function readJSON(store, key) {
  for (let i = 0; i < 5; i++) {
    const r = await store.getWithMetadata(key, { type: "json" });
    if (!r) return { data: null, etag: null };
    if (r.etag) return { data: r.data, etag: r.etag };
    if (!store.list) break;
    const before = await listedEtag(store, key);
    const again = await store.getWithMetadata(key, { type: "json" });
    const after = await listedEtag(store, key);
    if (again && before && before === after) return { data: again.data, etag: after };
  }
  throw new Error("Storage did not return a stable version tag; refusing an unsafe write");
}

export const getJSON = async (store, key) => (await store.getWithMetadata(key, { type: "json" }))?.data ?? null;

/** Create only if the key is new. Returns true if created. */
export async function createJSON(store, key, data) {
  return (await store.setJSON(key, data, { onlyIfNew: true })).modified;
}

/** Read-modify-write. fn(current|null) returns the new value, or undefined to leave it unchanged. */
export async function updateJSON(store, key, fn, retries = 6) {
  for (let i = 0; i < retries; i++) {
    const { data, etag } = await readJSON(store, key);
    const next = await fn(data);
    if (next === undefined) return data;
    const res = await store.setJSON(key, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res.modified) return next;
  }
  throw new Error("Too many simultaneous changes; please try again");
}

export async function removeKey(store, key) { if (store.delete) await store.delete(key); }
