/**
 * Privilege boundary verification against a real PostgreSQL instance.
 *
 * Run: pnpm --filter @agroclimate/database db:verify
 *
 * Probe objects get a per-run random suffix, so two concurrent runs create
 * distinct objects and neither can remove the other's. The old static names are
 * the decoy fixture in `verify-probe-isolation.mjs`, which asserts this run
 * leaves them alone.
 */
import { runPrivilegeVerification } from "./lib/privilege-verification.mjs";

const { failures, skipped } = await runPrivilegeVerification();

const summary =
  failures === 0
    ? `\nall privilege checks passed${skipped === 0 ? "" : ` (${skipped} skipped)`}`
    : `\n${failures} check(s) failed`;
console.log(summary);

if (failures > 0) process.exitCode = 1;
