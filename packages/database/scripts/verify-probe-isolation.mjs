/**
 * Probe isolation: the verification must not touch anything it did not create.
 *
 * Three properties, each one measured rather than argued:
 *
 *   1. Two runs in flight at once use distinct probe objects and both succeed.
 *   2. Objects carrying the pre-2.2.2.x static names — `app.privilege_probe` and
 *      friends — survive untouched, even though they look exactly like probes.
 *   3. Cleanup runs when the run itself fails, and it leaves no object behind.
 *
 * The failure path is driven through the library's `afterProbeSetup` hook
 * instead of an environment flag, so the production command keeps no test-only
 * branch.
 *
 * Run: pnpm --filter @agroclimate/database db:verify:probes
 */
import { Client } from "pg";

import { roleConnectionString } from "./lib/connections.mjs";
import { LEGACY_PROBE_NAMES, runPrivilegeVerification } from "./lib/privilege-verification.mjs";

let failures = 0;

function check(label, passed, detail) {
  if (passed) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
await owner.connect();

const created = { table: false, sequence: false, fn: false };
const [legacyTable, legacySequence, legacyFn] = LEGACY_PROBE_NAMES;

async function oidOf(kind, name) {
  const query =
    kind === "fn" ? "select to_regprocedure($1)::oid as oid" : "select to_regclass($1)::oid as oid";
  const { rows } = await owner.query(query, [kind === "fn" ? `app.${name}()` : `app.${name}`]);
  return rows[0].oid === null || rows[0].oid === undefined ? null : String(rows[0].oid);
}

/** Anything created by the current naming scheme, by either registry. */
async function probeObjects() {
  // The suffix shape is `_t_`, `_s_`, `_f_` plus a 12-hex token, which is what
  // keeps this apart from the legacy decoys (`privilege_probe_sequence`).
  const pattern = "privilege\\_probe\\_[tsf]\\_%";
  const { rows } = await owner.query(
    `select 'relation' as kind, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relname like $1
      union all
     select 'function' as kind, p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname like $1`,
    [pattern],
  );
  return rows.map((row) => `${row.kind}:${row.name}`).sort();
}

try {
  // ------------------------------------------------------- legacy-name decoys
  // Created here, tracked, and dropped here — never by the verification.
  const existing = await oidOf("table", legacyTable);
  if (existing === null) {
    await owner.query(`create table app.${legacyTable} (id integer primary key, secret text)`);
    created.table = true;
    await owner.query(`insert into app.${legacyTable} values (1, 'do not drop me')`);
  }
  if ((await oidOf("sequence", legacySequence)) === null) {
    await owner.query(`create sequence app.${legacySequence}`);
    created.sequence = true;
    await owner.query(`select setval('app.${legacySequence}', 41)`);
  }
  if ((await oidOf("fn", legacyFn)) === null) {
    await owner.query(
      `create function app.${legacyFn}() returns integer language sql as 'select 42'`,
    );
    created.fn = true;
  }

  const before = {
    table: await oidOf("table", legacyTable),
    sequence: await oidOf("sequence", legacySequence),
    fn: await oidOf("fn", legacyFn),
  };
  check(
    "legacy decoys exist before the run",
    Object.values(before).every((oid) => oid !== null),
  );

  // ------------------------------------------- two concurrent verifications
  const quiet = () => {};
  const [first, second] = await Promise.all([
    runPrivilegeVerification({ log: quiet, reBootstrap: false }),
    runPrivilegeVerification({ log: quiet, reBootstrap: false }),
  ]);

  check("concurrent run 1 passes", first.failures === 0, `${first.failures} failure(s)`);
  check("concurrent run 2 passes", second.failures === 0, `${second.failures} failure(s)`);
  check(
    "the two runs used distinct probe identifiers",
    first.probes.token !== second.probes.token,
    `${first.probes.token} vs ${second.probes.token}`,
  );

  // ------------------------------------------------- legacy decoys untouched
  const after = {
    table: await oidOf("table", legacyTable),
    sequence: await oidOf("sequence", legacySequence),
    fn: await oidOf("fn", legacyFn),
  };
  check(
    "pre-existing objects with the old static names are untouched",
    JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );

  const { rows: decoyRow } = await owner.query(`select secret from app.${legacyTable}`);
  check("legacy decoy table content is intact", decoyRow[0]?.secret === "do not drop me");

  const { rows: sequenceValue } = await owner.query(
    `select last_value::int from app.${legacySequence}`,
  );
  check(
    "legacy decoy sequence is intact",
    sequenceValue[0]?.last_value === 41,
    String(sequenceValue[0]?.last_value),
  );

  const { rows: fnValue } = await owner.query(`select app.${legacyFn}() as value`);
  check("legacy decoy function is intact", fnValue[0]?.value === 42);

  check(
    "no probe objects remain after successful runs",
    (await probeObjects()).length === 0,
    (await probeObjects()).join(", "),
  );

  // ------------------------------------------------------ cleanup after failure
  const forced = new Error("forced failure after probe setup");
  let threw = false;
  try {
    await runPrivilegeVerification({
      log: quiet,
      reBootstrap: false,
      hooks: {
        afterProbeSetup: () => {
          throw forced;
        },
      },
    });
  } catch (error) {
    threw = error === forced;
  }
  check("a failing run rethrows the original error", threw);
  check(
    "a failing run still removed its own probe objects",
    (await probeObjects()).length === 0,
    (await probeObjects()).join(", "),
  );
  check(
    "a failing run left the legacy decoys alone",
    (await oidOf("table", legacyTable)) === before.table,
  );
} finally {
  if (created.table) await owner.query(`drop table if exists app.${legacyTable}`).catch(() => {});
  if (created.sequence)
    await owner.query(`drop sequence if exists app.${legacySequence}`).catch(() => {});
  if (created.fn) await owner.query(`drop function if exists app.${legacyFn}()`).catch(() => {});
  await owner.end().catch(() => {});
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nprobe isolation verified");
}
