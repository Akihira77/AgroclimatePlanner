/**
 * Input validation and callback wiring, without a database.
 *
 * These assertions exist because the failure mode they prevent is silent: an
 * unvalidated id becomes a policy comparison that matches nothing, which looks
 * exactly like "this tenant has no data".
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createTenantScope, normaliseTenantId, TenantContextError } from "../../dist/index.js";

const TENANT = "01930000-0000-7000-8000-0000000000aa";

/** Minimal stand-in: records the context statement and the callback's client. */
function fakeClient() {
  const calls = { transactions: 0, raw: [] };
  const tx = {
    $queryRaw: (strings, ...values) => {
      calls.raw.push({ statement: strings.join("?"), values });
      return Promise.resolve([{ set_config: values[0] }]);
    },
    marker: "tx",
  };

  return {
    calls,
    tx,
    $transaction: async (fn) => {
      calls.transactions += 1;
      return fn(tx);
    },
  };
}

describe("normaliseTenantId", () => {
  test("accepts a canonical uuid and lowercases it", () => {
    assert.equal(normaliseTenantId(TENANT.toUpperCase()), TENANT);
    assert.equal(normaliseTenantId(TENANT), TENANT);
  });

  test("rejects anything a policy would silently compare against nothing", () => {
    for (const value of [
      "",
      " ",
      "not-a-uuid",
      "019300000000700080000000000000aa",
      "{01930000-0000-7000-8000-0000000000aa}",
      "01930000-0000-7000-8000-0000000000a",
      "01930000-0000-7000-8000-0000000000aaaa",
      "01930000-0000-7000-8000-0000000000aZ",
    ]) {
      assert.throws(
        () => normaliseTenantId(value),
        TenantContextError,
        `accepted ${JSON.stringify(value)}`,
      );
    }
  });

  test("rejects non-strings without calling String() on them", () => {
    for (const value of [undefined, null, 42, {}, []]) {
      assert.throws(() => normaliseTenantId(value), TenantContextError);
    }
  });
});

describe("withTenant", () => {
  test("validates before opening a transaction", async () => {
    const client = fakeClient();
    const scope = createTenantScope(client);

    await assert.rejects(
      scope.withTenant("nonsense", () => Promise.resolve(1)),
      TenantContextError,
    );
    assert.equal(client.calls.transactions, 0, "no transaction may be opened for an invalid id");
  });

  test("sets a transaction-local context, then runs the callback with the transaction client", async () => {
    const client = fakeClient();
    const scope = createTenantScope(client);

    const seen = await scope.withTenant(TENANT, (tx) => {
      assert.equal(tx.marker, "tx");
      return Promise.resolve("result");
    });

    assert.equal(seen, "result");
    assert.equal(client.calls.transactions, 1);
    assert.equal(client.calls.raw.length, 1);
    assert.match(client.calls.raw[0].statement, /set_config\('app\.user_id', \?, true\)/);
    assert.deepEqual(client.calls.raw[0].values, [TENANT]);
  });

  test("rejects a nested scope instead of opening a second transaction", async () => {
    const client = fakeClient();
    const scope = createTenantScope(client);

    await assert.rejects(
      scope.withTenant(TENANT, () => scope.withTenant(TENANT, () => Promise.resolve(1))),
      TenantContextError,
    );
    assert.equal(client.calls.transactions, 1, "the nested call must not open its own transaction");
  });

  test("rejects a missing callback", async () => {
    const client = fakeClient();
    const scope = createTenantScope(client);

    await assert.rejects(scope.withTenant(TENANT, undefined), TenantContextError);
    assert.equal(client.calls.transactions, 0);
  });

  test("propagates a callback error so the transaction rolls back", async () => {
    const client = fakeClient();
    const scope = createTenantScope(client);

    await assert.rejects(
      scope.withTenant(TENANT, () => Promise.reject(new Error("upstream failed"))),
      /upstream failed/,
    );
  });

  test("two concurrent scopes on the same client are not nested", async () => {
    const client = fakeClient();
    const scope = createTenantScope(client);

    const [first, second] = await Promise.all([
      scope.withTenant(TENANT, () => Promise.resolve("a")),
      scope.withTenant(TENANT, () => Promise.resolve("b")),
    ]);

    assert.equal(first, "a");
    assert.equal(second, "b");
    assert.equal(client.calls.transactions, 2);
  });
});
