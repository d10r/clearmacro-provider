import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Keystore } from "ox";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");

function makeWorkspace(options?: { precreateKeystore?: boolean }): string {
  const unique = mkdtempSync(join(tmpdir(), "clearmacro-prod-"));
  mkdirSync(join(unique, "config/oz-relayer/keys"), { recursive: true });
  mkdirSync(join(unique, "config/oz-relayer/networks"), { recursive: true });
  writeFileSync(
    join(unique, "config/registry.json"),
    `${JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 31337,
          forwarderAddress: "0x1111111111111111111111111111111111111111",
          rpcUrls: ["http://anvil:8545"],
          macroPolicy: { mode: "open" },
        },
      ],
    })}\n`,
  );
  if (options?.precreateKeystore ?? true) {
    writeFileSync(join(unique, "config/oz-relayer/keys/prod-relayer.json"), "{}\n");
  }
  return unique;
}

function scriptEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROVIDER_NAME: "prod-provider",
    OZ_RELAYER_API_KEY: "prod-relayer-api-key-32chars-minimum",
    OZ_WEBHOOK_SIGNING_KEY: "prod-webhook-signing-key-32chars-minimum",
    OZ_KEYSTORE_PASSPHRASE: "ProdPassphrase123!",
    OZ_STORAGE_ENCRYPTION_KEY: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=",
  };
}

function withoutEnv(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[name];
  return next;
}

describe("production scripts", () => {
  it("generates OZ relayer config from app-level registry", () => {
    const cwd = makeWorkspace();

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env: scriptEnv(),
      stdio: "pipe",
    });

    const config = JSON.parse(readFileSync(join(cwd, "config/oz-relayer/config.json"), "utf8")) as {
      relayers: { signer_id: string; network: string }[];
      signers: { id: string; config: { path: string; passphrase: { value: string } } }[];
    };
    expect(config.signers).toEqual([
      {
        id: "prod-signer",
        type: "local",
        config: {
          path: "./config/keys/prod-relayer.json",
          passphrase: { type: "env", value: "OZ_KEYSTORE_PASSPHRASE" },
        },
      },
    ]);
    expect(config.relayers).toEqual([
      expect.objectContaining({ network: "localhost-anvil", signer_id: "prod-signer" }),
    ]);

    const networks = JSON.parse(readFileSync(join(cwd, "config/oz-relayer/networks/evm.json"), "utf8")) as {
      networks: { chain_id: number; network: string }[];
    };
    expect(networks.networks).toEqual([expect.objectContaining({ chain_id: 31337, network: "localhost-anvil" })]);
  });

  it("creates a V3 keystore when missing without requiring cargo", () => {
    const cwd = makeWorkspace({ precreateKeystore: false });
    const fakeBinDir = join(cwd, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeCargoPath = join(fakeBinDir, "cargo");
    writeFileSync(
      fakeCargoPath,
      "#!/usr/bin/env sh\necho \"cargo must not be called by prod-init\" >&2\nexit 99\n",
      "utf8",
    );
    chmodSync(fakeCargoPath, 0o755);
    const env = {
      ...scriptEnv(),
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    };

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });

    const keystorePath = join(cwd, "config/oz-relayer/keys/prod-relayer.json");
    expect(existsSync(keystorePath)).toBe(true);
    const keystore = JSON.parse(readFileSync(keystorePath, "utf8")) as {
      version?: number;
      crypto?: { cipher?: string; ciphertext?: string; kdf?: string; mac?: string };
    };
    expect(keystore.version).toBe(3);
    expect(keystore.crypto?.cipher).toBe("aes-128-ctr");
    expect(keystore.crypto?.ciphertext).toEqual(expect.any(String));
    expect(keystore.crypto?.kdf).toEqual(expect.any(String));
    expect(keystore.crypto?.mac).toEqual(expect.any(String));
    const passphrase = scriptEnv().OZ_KEYSTORE_PASSPHRASE ?? "";
    const typedKeystore = keystore as Parameters<typeof Keystore.toKey>[0];
    const key = Keystore.toKey(typedKeystore, { password: passphrase });
    const privateKey = Keystore.decrypt(typedKeystore, key);
    expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("rejects --force until signer rotation is supported", () => {
    const cwd = makeWorkspace();
    expect(() =>
      execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts"), "--force"], {
        cwd,
        env: scriptEnv(),
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("supports validating custom keystore path under config/oz-relayer", () => {
    const cwd = makeWorkspace({ precreateKeystore: false });
    const env = {
      ...scriptEnv(),
      OZ_RELAYER_KEYSTORE_PATH: join(cwd, "config/oz-relayer/custom/subdir/prod-relayer.json"),
    };

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });
  });

  it("validates generated prod config and rejects local defaults", () => {
    const cwd = makeWorkspace();
    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env: scriptEnv(),
      stdio: "pipe",
    });

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
      cwd,
      env: scriptEnv(),
      stdio: "pipe",
    });

    expect(() =>
      execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
        cwd,
        env: { ...scriptEnv(), OZ_KEYSTORE_PASSPHRASE: "change-me" },
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("generates the internal OZ relayer API key when missing", () => {
    const cwd = makeWorkspace();
    const env = withoutEnv(scriptEnv(), "OZ_RELAYER_API_KEY");

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });

    const envPath = join(cwd, ".env");
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toMatch(/^OZ_RELAYER_API_KEY=.{32,}$/m);

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });
  });

  it("generates the local keystore passphrase when missing", () => {
    const cwd = makeWorkspace();
    const env = withoutEnv(scriptEnv(), "OZ_KEYSTORE_PASSPHRASE");

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });

    const envPath = join(cwd, ".env");
    expect(readFileSync(envPath, "utf8")).toMatch(/^OZ_KEYSTORE_PASSPHRASE=Cm-.+-1aA!$/m);

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });
  });

  it("generates webhook signing key when missing", () => {
    const cwd = makeWorkspace();
    const env = withoutEnv(scriptEnv(), "OZ_WEBHOOK_SIGNING_KEY");

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });

    const envPath = join(cwd, ".env");
    expect(readFileSync(envPath, "utf8")).toMatch(/^OZ_WEBHOOK_SIGNING_KEY=.{32,}$/m);

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });
  });

  it("generates storage encryption key when missing", () => {
    const cwd = makeWorkspace();
    const env = withoutEnv(scriptEnv(), "OZ_STORAGE_ENCRYPTION_KEY");

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-init.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });

    const envPath = join(cwd, ".env");
    expect(readFileSync(envPath, "utf8")).toMatch(/^OZ_STORAGE_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$/m);

    execFileSync(tsxBin, [resolve(repoRoot, "scripts/prod-validate.ts")], {
      cwd,
      env,
      stdio: "pipe",
    });
  });
});
