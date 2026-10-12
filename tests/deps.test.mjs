import { test } from "node:test";
import assert from "node:assert/strict";
import { matchingPublishableKey } from "../lib/deps.mjs";

test("publishable key is only used when its mode matches the secret key", () => {
  const err = console.error; console.error = () => {};
  try {
    assert.equal(matchingPublishableKey("pk_test_abc", "sk_test_xyz"), "pk_test_abc");
    assert.equal(matchingPublishableKey("pk_live_abc", "sk_live_xyz"), "pk_live_abc");
    assert.equal(matchingPublishableKey(" pk_live_abc ", "rk_live_xyz"), "pk_live_abc");
    assert.equal(matchingPublishableKey("pk_live_abc", "sk_test_xyz"), "", "live publishable + test secret -> hosted page");
    assert.equal(matchingPublishableKey("pk_test_abc", "sk_live_xyz"), "", "test publishable + live secret -> hosted page");
    assert.equal(matchingPublishableKey("sk_test_oops", "sk_test_xyz"), "", "secret key pasted by mistake is never sent to browsers");
    assert.equal(matchingPublishableKey("", "sk_test_xyz"), "");
  } finally { console.error = err; }
});
