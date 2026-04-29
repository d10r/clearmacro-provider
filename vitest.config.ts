import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["ethereum-contracts/**", "spikes/**", "dist/**", "node_modules/**"],
  },
});

