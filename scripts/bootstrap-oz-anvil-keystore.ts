import { spawn } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outputPath = resolve("config/oz-relayer/keys/anvil-relayer.json");
const keyDir = dirname(outputPath);
const accountName = "clearmacro-anvil-relayer";
const privateKey =
  process.env.RELAYER_SIGNER_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044976f6f2f4dc3d6ca4b9f5f3f6f5f78e40d778f0d4d5";
const password = process.env.OZ_KEYSTORE_PASSPHRASE ?? "change-me";

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

  await rename(resolve(keyDir, accountName), outputPath);
  console.log(`Keystore written at ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
