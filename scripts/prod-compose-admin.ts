/**
 * Host wrapper: run prod admin scripts inside the Compose `admin` job on the internal network.
 *
 * Usage (via package.json):
 *   pnpm run prod:apply-config [-- flags]
 *   pnpm run prod:apply-config -- --no-restart-app   # skip host app restart after apply
 *   pnpm run prod:check-config
 *   pnpm run prod:verify-oz-import
 */
import type { AdminScript } from "./lib/prod-compose-admin.js";
import {
  buildComposeRestartAppCommand,
  buildComposeRunCommand,
  parseUserArgs,
  runDocker,
  shouldRestartAppAfterApply,
} from "./lib/prod-compose-admin.js";

const SCRIPTS = new Set<AdminScript>(["apply-config", "check-config", "verify-oz-import"]);

function usage(): never {
  console.error("Usage: prod-compose-admin.ts <apply-config|check-config|verify-oz-import> [-- flags]");
  process.exit(1);
}

function main(): void {
  const scriptArg = process.argv[2];
  if (!scriptArg || !SCRIPTS.has(scriptArg as AdminScript)) {
    usage();
  }
  const script = scriptArg as AdminScript;
  const userArgs = parseUserArgs(process.argv.slice(3));

  const runStatus = runDocker(buildComposeRunCommand(script, userArgs));
  if (runStatus !== 0) {
    process.exit(runStatus);
  }

  if (script === "apply-config" && shouldRestartAppAfterApply(userArgs)) {
    const restartStatus = runDocker(buildComposeRestartAppCommand());
    if (restartStatus !== 0) {
      console.error(
        "Admin job succeeded but failed to restart app. Run manually: docker compose -f compose.prod.yaml restart app",
      );
      process.exit(restartStatus);
    }
    console.log("Restarted app service.");
  }
}

main();
