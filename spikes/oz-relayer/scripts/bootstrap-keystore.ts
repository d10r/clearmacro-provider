import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const outputPath = resolve("spikes/oz-relayer/config/keys/anvil-relayer.json");
const keyDir = dirname(outputPath);
const accountName = "oz-spike-anvil-relayer";
const privateKey =
  process.env.RELAYER_SIGNER_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044976f6f2f4dc3d6ca4b9f5f3f6f5f78e40d778f0d4d5";
const password = process.env.KEYSTORE_PASSPHRASE ?? "test";

function run(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        CAST_UNSAFE_PASSWORD: password,
      },
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function main() {
  await mkdir(keyDir, { recursive: true });

  await run("cast", [
    "wallet",
    "import",
    accountName,
    "--private-key",
    privateKey,
    "--keystore-dir",
    keyDir,
    "--unsafe-password",
    password,
  ]);

  const generated = resolve(keyDir, accountName);
  await rename(generated, outputPath);
  console.log(`Keystore written at ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
