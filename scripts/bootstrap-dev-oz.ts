/**
 * Bootstrap local OpenZeppelin Relayer files for compose.yaml (Anvil dev stack).
 *
 * Copies example config when missing, creates the Anvil keystore, generates
 * networks/evm.json from provider config, and sets OZ submission RPC to anvil:8545.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");

function copyIfMissing(src: string, dest: string, label: string): void {
  if (existsSync(dest)) {
    console.log(`Keeping existing ${label}: ${dest}`);
    return;
  }
  copyFileSync(src, dest);
  console.log(`Created ${label}: ${dest}`);
}

function patchAnvilOzRpc(evmPath: string): void {
  const raw = JSON.parse(readFileSync(evmPath, "utf8")) as {
    networks: Array<{ network?: string; rpc_urls?: string[] }>;
  };
  let patched = false;
  for (const net of raw.networks) {
    if (net.network === "localhost-anvil") {
      net.rpc_urls = ["http://anvil:8545"];
      patched = true;
    }
  }
  if (!patched) {
    throw new Error(`No localhost-anvil network in ${evmPath}; check provider config chainId 31337`);
  }
  writeFileSync(evmPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  console.log(`Set OZ submission RPC for localhost-anvil to http://anvil:8545 in ${evmPath}`);
}

function run(): void {
  const providerPath = resolve(repoRoot, "config/provider.json");
  const providerAnvil = resolve(repoRoot, "config/provider.anvil.json");
  const ozConfigPath = resolve(repoRoot, "config/oz-relayer/config.json");
  const ozConfigExample = resolve(repoRoot, "config/oz-relayer/config.example.json");
  const evmPath = resolve(repoRoot, "config/oz-relayer/networks/evm.json");

  copyIfMissing(providerAnvil, providerPath, "provider.json");
  copyIfMissing(ozConfigExample, ozConfigPath, "config/oz-relayer/config.json");

  const keystore = spawnSync(tsxBin, [resolve(repoRoot, "scripts/bootstrap-oz-anvil-keystore.ts")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (keystore.status !== 0) {
    throw new Error("oz:bootstrap:anvil failed");
  }

  const generator = spawnSync(
    tsxBin,
    [
      resolve(repoRoot, "scripts/generate-oz-relayer-networks.ts"),
      providerPath,
      "--update-config",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (generator.status !== 0) {
    throw new Error("oz:gen:networks failed");
  }

  patchAnvilOzRpc(evmPath);
  console.log("Local OZ relayer bootstrap complete. Start the stack with: pnpm run stack:dev");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
