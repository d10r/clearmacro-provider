import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "dist/**",
    "node_modules/**",
    "coverage/**",
    "ethereum-contracts/**",
    "foundry/**",
    "openzeppelin-relayer/**",
    "superfluid-dashboard/**",
    "protocol-monorepo/**",
    "tmp/**",
    ".tmp/**",
    ".cache/**",
    ".corepack/**",
    ".pnpm-store/**",
    "test/fixtures/contracts/out/**",
    "test/fixtures/contracts/cache/**",
    "test/fixtures/contracts/lib/**",
    ".cursor/**",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
