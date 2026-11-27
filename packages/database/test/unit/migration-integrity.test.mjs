/**
 * The applied-migration comparison, exercised without a database.
 *
 * The wrapper's job is I/O: read directories, hash files, run one SELECT. The
 * decision is `checkMigrations`, and two of its four branches are easy to break
 * silently because they are the ones nobody provokes by hand — a row recorded as
 * rolled back, and a row that started and never finished. The tamper branch is
 * the famous one; the others are here so a future edit cannot delete one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkMigrations } from "../../scripts/lib/migration-integrity.mjs";

const row = (name, overrides = {}) => ({
  name,
  checksum: "a".repeat(64),
  finished_at: new Date("2026-11-27T00:00:00Z"),
  rolled_back_at: null,
  ...overrides,
});

const checksumOf = () => "a".repeat(64);

describe("checkMigrations", () => {
  it("passes when every applied file matches its checksum", () => {
    const { failures, pending } = checkMigrations({
      applied: [row("20260101000000_one")],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.deepEqual(failures, []);
    assert.deepEqual(pending, []);
  });

  it("fails a file edited after it was applied, and names both digests", () => {
    const { failures } = checkMigrations({
      applied: [row("20260101000000_one")],
      directories: ["20260101000000_one"],
      checksumOf: () => "b".repeat(64),
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /edited after it was applied/);
    assert.match(failures[0], /recorded aaaaaaaaaaaa…, file bbbbbbbbbbbb…/);
  });

  it("fails an applied migration whose directory is gone", () => {
    const { failures } = checkMigrations({
      applied: [row("20260101000000_one")],
      directories: [],
      checksumOf,
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /applied, but its directory is gone/);
  });

  it("fails a migration marked rolled back and never re-applied", () => {
    const { failures, pending } = checkMigrations({
      applied: [row("20260101000000_one", { rolled_back_at: new Date() })],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /marked rolled back and never re-applied/);
    // One problem, not two: the directory is accounted for by the ledger row.
    assert.deepEqual(pending, []);
  });

  it("passes the repaired state Prisma leaves behind: a rolled-back row plus an applied one", () => {
    // `prisma migrate resolve --rolled-back` then `migrate deploy` appends a row
    // rather than editing the first. Measured on a cloned database 2026-11-28.
    const { failures, pending } = checkMigrations({
      applied: [
        row("20260101000000_one", { finished_at: null, rolled_back_at: new Date() }),
        row("20260101000000_one"),
      ],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.deepEqual(failures, []);
    assert.deepEqual(pending, []);
    // Two ledger rows, one migration: the summary must not double-count.
    assert.equal(
      checkMigrations({
        applied: [
          row("20260101000000_one", { finished_at: null, rolled_back_at: new Date() }),
          row("20260101000000_one"),
        ],
        directories: ["20260101000000_one"],
        checksumOf,
      }).applied,
      1,
    );
  });

  it("says started-and-never-finished when a later attempt is also open", () => {
    // Reachable: resolve the failed row, `deploy` starts again and the process
    // dies. The schema is in an unknown state, not merely rolled back.
    const { failures } = checkMigrations({
      applied: [
        row("20260101000000_one", { finished_at: null, rolled_back_at: new Date() }),
        row("20260101000000_one", { finished_at: null }),
      ],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /started and never finished/);
  });

  it("compares the applied row's checksum, not the failed attempt's", () => {
    // A migration that failed, was edited, resolved and re-applied has two rows
    // with different digests. Reading the wrong one would fail a healthy ledger.
    const { failures } = checkMigrations({
      applied: [
        row("20260101000000_one", {
          checksum: "b".repeat(64),
          finished_at: null,
          rolled_back_at: new Date(),
        }),
        row("20260101000000_one"),
      ],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.deepEqual(failures, []);
  });

  it("fails a row that started and never finished, and names the resolve command", () => {
    const { failures } = checkMigrations({
      applied: [row("20260101000000_one", { finished_at: null })],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /started and never finished/);
    assert.match(failures[0], /migrate resolve --rolled-back 20260101000000_one/);
  });

  it("fails a settled row with no recorded checksum instead of crashing on it", () => {
    const { failures } = checkMigrations({
      applied: [row("20260101000000_one", { checksum: null })],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /no checksum recorded/);
  });

  it("keeps checking after an unreadable file instead of aborting the run", () => {
    const { failures } = checkMigrations({
      applied: [row("20260101000000_one"), row("20260102000000_two")],
      directories: ["20260101000000_one", "20260102000000_two"],
      checksumOf: (name) => {
        if (name === "20260101000000_one")
          throw Object.assign(new Error("nope"), { code: "ENOENT" });
        return "a".repeat(64);
      },
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /migration\.sql is missing or unreadable \(ENOENT\)/);
  });

  it("reports a directory with no applied row as pending, and does not fail it", () => {
    const { failures, pending } = checkMigrations({
      applied: [row("20260101000000_one")],
      directories: ["20260101000000_one", "20260102000000_two"],
      checksumOf,
    });

    assert.deepEqual(failures, []);
    assert.deepEqual(pending, ["20260102000000_two"]);
  });

  it("fails a database with no ledger, rather than reporting zero rows as success", () => {
    const { failures } = checkMigrations({
      applied: [],
      directories: ["20260101000000_one"],
      checksumOf,
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /no applied migrations in this database/);
  });
});
