import { CONTRACTS_VERSION, weatherDataClassSchema } from "@agroclimate/contracts";

/**
 * Phase 2.0 worker entry point. No Redis, no PostgreSQL, no queues — the
 * process exists to prove that the workspace resolves and shared contracts
 * load in a non-HTTP runtime.
 */
function main(): void {
  console.log(
    `[worker] started; contracts ${CONTRACTS_VERSION}; ${weatherDataClassSchema.options.length} data classes; no queues registered`,
  );
}

main();
