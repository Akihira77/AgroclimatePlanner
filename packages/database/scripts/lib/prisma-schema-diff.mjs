/**
 * The comparison `verify-prisma-schema.mjs` makes, as a library.
 *
 * The script has to spawn `prisma migrate diff`, so it cannot be unit tested
 * end to end without a database. The part that decides pass or fail can be, and
 * is: `test/unit/prisma-schema-diff.test.mjs`. That matters more than it sounds,
 * because the guard is the only thing in the repository that notices schema
 * drift, and a guard that fails open is worse than no guard.
 */

/**
 * The statements Prisma always wants and can never have: `fields.area_ha` is
 * `GENERATED ALWAYS AS (...) STORED`, and the schema language has no syntax for
 * a generated column.
 */
export const UNEXPRESSIBLE = [
  'ALTER TABLE "fields" ALTER COLUMN "area_ha" DROP DEFAULT,',
  'ALTER COLUMN "area_ha" SET DATA TYPE double precision;',
].join("\n");

/**
 * Prisma's script, split into comparable statements.
 *
 * Comments are dropped, the rest is split on `;` and whitespace is collapsed, so
 * a formatting difference is not a drift. A comment is only ever a comment in
 * Prisma's output — nothing here emits `--` inside a string literal.
 */
export function statements(script) {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.replace(/\s+/g, " "));
}

/**
 * Both directions. A missing statement is as much a difference as an extra one:
 * an empty script is the healthy case, so a script that loses the one statement
 * it is supposed to carry must not read as agreement.
 */
export function compareSchemaDiff(script, unexpressible = UNEXPRESSIBLE) {
  const expected = statements(unexpressible);
  const actual = statements(script);
  return {
    unexpected: actual.filter((statement) => !expected.includes(statement)),
    absent: expected.filter((statement) => !actual.includes(statement)),
  };
}
