import "reflect-metadata";

import { createApplication } from "./app.factory.js";
import { parseRuntimeConfig, readEnvironment } from "./config/runtime-config.js";

async function bootstrap(): Promise<void> {
  const config = parseRuntimeConfig(readEnvironment());
  const app = await createApplication({ config });
  await app.listen(config.port);
  console.log(`[api] listening on ${config.port}`);
}

void bootstrap().catch((error: unknown) => {
  // Configuration errors name the variable, never its value. Anything else is
  // reported by name only until the filter exists (it needs a request).
  console.error(`[api] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
