import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { retryDelayMsFor } from "../../dist/queue/postgres.js";

describe("retryDelayMsFor", () => {
  it("follows the approved 1 / 5 / 20 minute ladder", () => {
    assert.equal(retryDelayMsFor(1), 60_000);
    assert.equal(retryDelayMsFor(2), 5 * 60_000);
    assert.equal(retryDelayMsFor(3), 20 * 60_000);
  });

  it("stays at the ceiling instead of growing without bound", () => {
    assert.equal(retryDelayMsFor(4), 20 * 60_000);
    assert.equal(retryDelayMsFor(5), 20 * 60_000);
  });
});
