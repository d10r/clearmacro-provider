import { describe, expect, it } from "vitest";
import {
  buildComposeRestartAppCommand,
  buildComposeRunCommand,
  containerArgsFor,
  scriptDistPath,
  shouldRestartAppAfterApply,
} from "../../scripts/lib/prod-compose-admin.js";

describe("prod-compose-admin helpers", () => {
  it("maps scripts to dist paths", () => {
    expect(scriptDistPath("apply-config")).toBe("dist/scripts/prod-apply-config.js");
    expect(scriptDistPath("check-config")).toBe("dist/scripts/prod-check-config.js");
  });

  it("strips host-only flags before passing args to the admin container", () => {
    expect(containerArgsFor("apply-config", [])).toEqual([]);
    expect(containerArgsFor("apply-config", ["--dry-run"])).toEqual(["--dry-run"]);
    expect(containerArgsFor("apply-config", ["--no-restart-app", "--dry-run"])).toEqual(["--dry-run"]);
    expect(containerArgsFor("check-config", ["--no-restart-app"])).toEqual([]);
  });

  it("builds docker compose run command for apply-config", () => {
    expect(buildComposeRunCommand("apply-config", ["--dry-run"], "compose.prod.yaml")).toEqual([
      "compose",
      "-f",
      "compose.prod.yaml",
      "run",
      "--rm",
      "--build",
      "admin",
      "node",
      "dist/scripts/prod-apply-config.js",
      "--dry-run",
    ]);
  });

  it("builds docker compose run command for check-config", () => {
    expect(buildComposeRunCommand("check-config", [], "compose.prod.yaml")).toEqual([
      "compose",
      "-f",
      "compose.prod.yaml",
      "run",
      "--rm",
      "--build",
      "admin",
      "node",
      "dist/scripts/prod-check-config.js",
    ]);
  });

  it("decides host app restart after apply-config", () => {
    expect(shouldRestartAppAfterApply([])).toBe(true);
    expect(shouldRestartAppAfterApply(["--dry-run"])).toBe(false);
    expect(shouldRestartAppAfterApply(["--no-restart-app"])).toBe(false);
    expect(shouldRestartAppAfterApply(["--dry-run", "--no-restart-app"])).toBe(false);
  });

  it("builds docker compose restart app command", () => {
    expect(buildComposeRestartAppCommand("compose.prod.yaml")).toEqual([
      "compose",
      "-f",
      "compose.prod.yaml",
      "restart",
      "app",
    ]);
  });
});
