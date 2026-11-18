import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IsInt, IsOptional, IsString } from "class-validator";

import { createValidationPipe } from "../dist/http/validation.pipe.js";

/**
 * The pipe is exercised directly rather than through a route: Phase 3.2 adds no
 * request DTOs, and adding an endpoint only to have something to validate would
 * put test scaffolding in the public surface.
 *
 * The decorators are applied by hand because this file is plain JavaScript and
 * `@decorator` syntax needs compilation. The metadata they register is the same.
 */
class SampleQuery {}
IsString()(SampleQuery.prototype, "name");
IsOptional()(SampleQuery.prototype, "count");
IsInt()(SampleQuery.prototype, "count");

const metadata = { type: "query", metatype: SampleQuery };

async function run(value) {
  return createValidationPipe().transform(value, metadata);
}

describe("global validation policy", () => {
  it("keeps a declared property", async () => {
    const result = await run({ name: "irigasi" });
    assert.equal(result.name, "irigasi");
  });

  it("rejects an unknown property instead of stripping it", async () => {
    await assert.rejects(
      () => run({ name: "irigasi", isAdmin: "true" }),
      (error) => {
        assert.equal(error.getStatus(), 400);
        const body = error.getResponse();
        assert.deepEqual(body.details, [{ path: "isAdmin", issue: "whitelistValidation" }]);
        return true;
      },
    );
  });

  it("does not enable implicit conversion", async () => {
    // `"3"` must stay a string, so the integer rule fails. With implicit
    // conversion on, class-transformer would coerce it and this would pass.
    await assert.rejects(
      () => run({ name: "irigasi", count: "3" }),
      (error) => {
        assert.equal(error.getStatus(), 400);
        const body = error.getResponse();
        assert.deepEqual(body.details, [{ path: "count", issue: "isInt" }]);
        return true;
      },
    );

    const converted = await run({ name: "irigasi", count: 3 });
    assert.equal(converted.count, 3);
  });

  it("never puts the submitted value in the details", async () => {
    await assert.rejects(
      () => run({ name: 42 }),
      (error) => {
        const serialised = JSON.stringify(error.getResponse());
        assert.equal(serialised.includes("42"), false);
        return true;
      },
    );
  });
});
