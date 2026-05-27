import { spawnSync } from "node:child_process";

export type AdminScript = "apply-config" | "check-config";

const SCRIPT_FILE: Record<AdminScript, string> = {
  "apply-config": "dist/scripts/prod-apply-config.js",
  "check-config": "dist/scripts/prod-check-config.js",
};

export function resolveComposeProdFile(): string {
  return process.env.COMPOSE_PROD_FILE ?? "compose.prod.yaml";
}

export function scriptDistPath(script: AdminScript): string {
  return SCRIPT_FILE[script];
}

/** User flags from argv (after script name). */
export function parseUserArgs(argv: string[]): string[] {
  return argv.filter((a) => a !== "--");
}

/** Flags interpreted only by the host wrapper, not passed into the admin container. */
const HOST_ONLY_FLAGS = new Set(["--no-restart-app"]);

export function containerArgsFor(_script: AdminScript, userArgs: string[]): string[] {
  return userArgs.filter((a) => !HOST_ONLY_FLAGS.has(a));
}

/** Restart app on host after a successful apply-config (not dry-run / not --no-restart-app). */
export function shouldRestartAppAfterApply(userArgs: string[]): boolean {
  if (userArgs.includes("--dry-run") || userArgs.includes("--no-restart-app")) {
    return false;
  }
  return true;
}

export function buildComposeRunCommand(
  script: AdminScript,
  userArgs: string[],
  composeFile = resolveComposeProdFile(),
): string[] {
  const nodeScript = scriptDistPath(script);
  const innerArgs = containerArgsFor(script, userArgs);
  return [
    "compose",
    "-f",
    composeFile,
    "run",
    "--rm",
    "--build",
    "admin",
    "node",
    nodeScript,
    ...innerArgs,
  ];
}

export function buildComposeRestartAppCommand(composeFile = resolveComposeProdFile()): string[] {
  return ["compose", "-f", composeFile, "restart", "app"];
}

export function runDocker(args: string[]): number {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  return result.status ?? 1;
}
