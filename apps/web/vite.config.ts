import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * The dev server forwards `/v1` to the API, so the browser talks to one origin and
 * the session cookie is same-site without CORS.
 *
 * The API reads `PORT` from the same repository-root environment file the API
 * process loads, so the proxy cannot drift from the port the server actually
 * bound. `strictPort` makes an occupied 5173 fail loudly instead of moving to 5174,
 * which the API's origin allowlist would refuse anyway.
 */
export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const port = loadEnv(mode, repositoryRoot, "PORT")["PORT"] ?? "3000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/v1": { target: `http://127.0.0.1:${port}` },
      },
    },
  };
});
