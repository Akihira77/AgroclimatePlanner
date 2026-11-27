import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * The dev server forwards `/v1` to the API, so the browser talks to one origin and
 * the session cookie is same-site without CORS.
 *
 * The API reads `PORT` from the same repository-root environment file the API
 * process loads, so the proxy cannot drift from the port the server actually
 * bound. `strictPort` makes an occupied port fail loudly instead of moving to the
 * next one, which the API's origin allowlist would refuse anyway.
 *
 * `WEB_PORT` exists because 5173 is not always free — another project on the same
 * machine may hold it. Moving the dev server means setting two things that must
 * agree: `WEB_PORT` here, and `CORS_ORIGINS` for the API, because the browser's
 * `Origin` is the dev server's port even though `/v1` is proxied.
 *
 * One asymmetry to know about: `loadEnv` also merges the mode-local files Vite
 * documents, while the API loads only the root environment file. A `PORT` set in one
 * of those extra files therefore moves this proxy and not the server it points at.
 * Keep these values in the root file, which is the one both processes read.
 */
/**
 * A port that is not a port fails here rather than as a puzzling 403. `WEB_PORT=0`
 * would ask the OS for an ephemeral port the API's allowlist has never heard of, and
 * `strictPort` would not save anyone: the failure would arrive on the first POST.
 */
function portFrom(name: string, value: string | undefined, fallback: string): number {
  // An empty value means "unset", which is what the API's own port parsing does.
  const parsed = Number(value === undefined || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const env = loadEnv(mode, repositoryRoot, "");
  const port = portFrom("PORT", env["PORT"], "3000");
  const webPort = portFrom("WEB_PORT", env["WEB_PORT"], "5173");

  return {
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        "/v1": { target: `http://127.0.0.1:${port}` },
      },
    },
  };
});
