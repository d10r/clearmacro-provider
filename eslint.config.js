import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
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
    "tmp/**",
    "test/fixtures/contracts/out/**",
    "test/fixtures/contracts/cache/**",
    "test/fixtures/contracts/lib/**",
    ".cursor/**",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
