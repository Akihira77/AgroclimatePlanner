// dist/cjs holds CommonJS output, but the package is `"type": "module"`.
// Without this marker Node would parse the CJS build as ESM and fail on
// `exports` being undefined.
import { writeFile } from "node:fs/promises";

await writeFile(new URL("../dist/cjs/package.json", import.meta.url), '{"type":"commonjs"}\n');
