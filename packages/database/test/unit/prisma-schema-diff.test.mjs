/**
 * The schema-drift guard's decision, without a database.
 *
 * `verify-prisma-schema.mjs` spawns Prisma and queries the catalogue, so it has
 * no unit test. The comparison is where the guard fails open if it fails at
 * all — an `includes` in the wrong direction, an allowlist that grew, a parser
 * that joins two statements into one that matches neither. Those cases are pure
 * input to output, and each one is exercised here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareSchemaDiff,
  statements,
  UNEXPRESSIBLE,
} from "../../scripts/lib/prisma-schema-diff.mjs";

describe("statements", () => {
  it("drops comments, splits on the terminator and collapses whitespace", () => {
    const script = [
      "-- DropForeignKey",
      'ALTER TABLE "a" DROP CONSTRAINT "b";',
      "",
      "-- AlterTable",
      'ALTER TABLE "fields"   ALTER COLUMN "area_ha" DROP DEFAULT,',
      'ALTER COLUMN "area_ha" SET DATA TYPE double precision;',
    ].join("\n");
    assert.deepEqual(statements(script), [
      'ALTER TABLE "a" DROP CONSTRAINT "b"',
      'ALTER TABLE "fields" ALTER COLUMN "area_ha" DROP DEFAULT, ALTER COLUMN "area_ha" SET DATA TYPE double precision',
    ]);
  });

  it("treats an empty script as no statements rather than one empty one", () => {
    assert.deepEqual(statements(""), []);
    assert.deepEqual(statements("\n\n-- nothing to do\n"), []);
  });
});

describe("compareSchemaDiff", () => {
  it("accepts the script that contains exactly the inexpressible statement", () => {
    assert.deepEqual(compareSchemaDiff(UNEXPRESSIBLE), { unexpected: [], absent: [] });
  });

  it("fails on one extra statement, which is real drift", () => {
    const { unexpected, absent } = compareSchemaDiff(
      `${UNEXPRESSIBLE}\nDROP INDEX "sessions_token_hash_key";`,
    );
    (assert.deepEqual(unexpected, ['DROP INDEX "sessions_token_hash_key"']),
      "an index Prisma would drop must be reported, not ignored");
    assert.deepEqual(absent, []);
  });

  it("fails when the allowlisted statement is gone, which is a changed premise", () => {
    const { unexpected, absent } = compareSchemaDiff(
      'ALTER TABLE "a" ADD CONSTRAINT "b" FOREIGN KEY ("c") REFERENCES "d"("e");',
    );
    assert.deepEqual(unexpected, [
      'ALTER TABLE "a" ADD CONSTRAINT "b" FOREIGN KEY ("c") REFERENCES "d"("e")',
    ]);
    assert.equal(absent.length, 1, "the absent allowlist statement must be named");
  });

  it("fails on an empty script instead of reading it as agreement", () => {
    const { absent } = compareSchemaDiff("");
    assert.equal(absent.length, 1, "a diff that produced nothing must not pass as an empty diff");
  });

  it("does not let a reformatted statement pass as one it replaced", () => {
    const reformatted = UNEXPRESSIBLE.replace(
      'ALTER COLUMN "area_ha" SET DATA TYPE',
      "ALTER COLUMN  area_ha  TYPE",
    );
    const { unexpected, absent } = compareSchemaDiff(reformatted);
    assert.equal(unexpected.length, 1, "a changed statement is drift, not a match");
    assert.equal(absent.length, 1);
  });
});
