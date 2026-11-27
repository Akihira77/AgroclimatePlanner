/**
 * The v1 catalogue: four crops, one cultivar each, one published rulebook each.
 *
 * `OPEN-20` was decided 2026-11-28 — all four crops ship, with the genuinely
 * missing thresholds absent rather than guessed
 * (`docs/research/agronomic-reference-matrix.md` §5 and §7). The content lives in
 * `lib/catalog-seed-data.mjs` and the routine in `lib/catalog-seed.mjs`, so both can
 * be checked without a database.
 *
 * What it deliberately does not do:
 *
 * - No water rule for kedelai or cabai. The matrix says their water dimension is
 *   `insufficient_data`, and a constraint row cannot express "unknown" — inventing
 *   a band would be the fabricated recommendation the engine refuses.
 * - No citation dressed up as the document it is not. Two of the five URLs are the
 *   document; two only reach an institutional homepage and say so in their title; the
 *   sources the matrix names with no stable URL at all are recorded in
 *   `docs/IMPLEMENTATION_STATUS.md` as a gap instead of guessed here.
 * - No update of an existing row. Published profile versions are immutable by
 *   trigger, so a second run adds what is missing and reports the rest.
 *
 * Run as `migration_owner`: catalog rows are global reference data, and no runtime
 * role may write them (`ownership-and-rls.md`, `D13`).
 */
import { Client } from "pg";

import { seedCatalogue } from "./lib/catalog-seed.mjs";
import { roleConnectionString } from "./lib/connections.mjs";

const connectionString = roleConnectionString("migration_owner");
// The output names the database it wrote to. Two environments with the same data
// produce identical per-crop lines, so without this a seed against the wrong
// `POSTGRES_DB` is indistinguishable from a correct one after the fact. The
// password is in the connection string and must never be printed.
const target = new URL(connectionString);
const where = `${target.hostname}:${target.port || 5432}${target.pathname}`;

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("begin");
  const report = await seedCatalogue(client);
  await client.query("commit");
  for (const line of report) console.log(line);
  console.log(`catalogue seed finished on ${where}`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
