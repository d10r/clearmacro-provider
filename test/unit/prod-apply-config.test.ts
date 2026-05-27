import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const scriptPath = resolve(repoRoot, "scripts/prod-apply-config.ts");

describe("prod:apply-config CLI", () => {
  it("exits non-zero when required API key is missing", () => {
    expect(() =>
      execFileSync(tsxBin, [scriptPath, "--dry-run"], {
        cwd: repoRoot,
        env: { ...process.env, OZ_RELAYER_URL: "", OZ_RELAYER_API_KEY: "" },
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
