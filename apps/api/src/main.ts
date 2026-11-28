import "reflect-metadata";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveOpenMeteoLicenseConfig,
  unvalidatedGridRegistry,
  validatedOpenMeteoGridRegistry,
} from "@agroclimate/weather-core";

import { createApplication } from "./app.factory.js";
import { createLlmBriefingProviderFromEnv } from "./briefing/llm-provider.js";
import { loadLocalEnv, parseRuntimeConfig, readEnvironment } from "./config/runtime-config.js";

// The repository-root local file sits three levels above both `src/main.ts` and
// `dist/main.js`, so one relative path resolves from either.
const localEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(localEnv)) loadLocalEnv(localEnv);

async function bootstrap(): Promise<void> {
  const env = readEnvironment();
  const config = parseRuntimeConfig(env);
  resolveOpenMeteoLicenseConfig(env);
  const briefingProvider = createLlmBriefingProviderFromEnv(env);
  const gridRegistry =
    config.nodeEnv !== "production"
      ? validatedOpenMeteoGridRegistry
      : env["WEATHER_PROVIDER_LICENSE_MODE"] !== undefined
        ? validatedOpenMeteoGridRegistry
        : unvalidatedGridRegistry;

  const app = await createApplication({
    config,
    gridRegistry,
    ...(briefingProvider === undefined ? {} : { briefingProvider }),
  });
  await app.listen(config.port);
  console.log(`[api] listening on ${config.port}`);
}

void bootstrap().catch((error: unknown) => {
  // Configuration errors name the variable, never its value. Anything else is
  // reported by name only until the filter exists (it needs a request).
  console.error(`[api] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
