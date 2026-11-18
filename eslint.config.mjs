import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Omit-style destructuring (`const { a: _a, ...rest }`) is how the tests
      // build "missing field" fixtures.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../packages/*", "../../../packages/*"],
              message: "Import shared code through its package export.",
            },
            {
              group: ["**/packages/*/src/**"],
              message: "Import shared code through its package export.",
            },
          ],
        },
      ],
    },
  },
);
