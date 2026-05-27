# OpenZeppelin Relayer Config

This directory is mounted into the OpenZeppelin Relayer container at `/app/config`.

Checked-in **examples** (`config.example.json`, `networks/evm.example.json`) document local wiring shape only. Generated runtime files (`config.json`, `networks/evm.json`, keystores) are gitignored and produced by `pnpm run dev:oz-bootstrap` (local Anvil) or `pnpm run prod:init` / `pnpm run prod:apply-config` (production).

## Docker bind mounts and keystore permissions

Compose mounts this directory at `/app/config` **read-only**. Keystore JSON from `pnpm run prod:init` is typically **`0600`** and owned by your login user. The OpenZeppelin Relayer container must run **as that same numeric UID/GID**, or startup will fail with a keystore `Permission denied` panic. Set **`OZ_RELAYER_UID`** and **`OZ_RELAYER_GID`** in `.env` to `id -u` / `id -g` on the host that owns `config/oz-relayer/keys/` (see `compose.prod.yaml` `user:` on the `oz-relayer` service). On Linux/macOS, **`pnpm run prod:init`** appends these to `.env` from `getuid`/`getgid` when they are missing. Local **`compose.yaml`** defaults to `1000:1000` if unset.

## Bootstrap files vs live OZ state

Files under this directory are **bootstrap / desired-state artifacts**. On first boot with an empty Redis volume, OpenZeppelin Relayer imports them once. With `REPOSITORY_STORAGE_TYPE=redis` and `RESET_STORAGE_ON_START=false` (production default), later edits to these files **do not** change live relayers until you reconcile via API.

Use **`pnpm run prod:apply-config`** after changing `config/provider.json` so live OZ networks/relayers match without wiping Redis. Run it from the host; it executes a Compose `admin` job that calls the OZ admin API at `http://oz-relayer:8080` on the internal network.

## Generate `networks/evm.json` from the registry

`networks/evm.json` is **not** committed. It is generated from `config/provider.json` and should match that file (enforced by `pnpm run prod:validate`).

From the repo root (after `pnpm install`), `@superfluid-finance/metadata` supplies chain names, testnet flag, native symbol, and public RPC fallbacks; your `config/provider.json` lists which chains to include and should set **`rpcUrls`** first when you use private endpoints.

```bash
# local Anvil stack (compose.yaml)
pnpm run dev:oz-bootstrap

# manual generation
pnpm run oz:gen:networks
# optional: registry path and dry-run
pnpm run oz:gen:networks -- path/to/provider.json --dry-run
# optional: rewrite config.json relayers[] to match (keeps signers, notifications, plugins)
pnpm run oz:gen:networks -- --update-config
# preferred for production: reconcile live OZ + update files + restart app
pnpm run prod:apply-config
```

**Local Anvil:** use `chainId` **31337** in the registry with `rpcUrls` (for example `http://anvil:8545` in Docker). That yields the `localhost-anvil` network block without Superfluid metadata.

**Still manual:** compose/env secrets (`STORAGE_ENCRYPTION_KEY`, API keys, passphrase) and production signer custody/rotation. With `--update-config`, generated relayers use **`OZ_RELAYER_SIGNER_ID`** or default to `prod-signer`; existing signers, notifications, and plugins in `config.json` are preserved.

Required runtime properties:

- `REPOSITORY_STORAGE_TYPE=redis`
- `RESET_STORAGE_ON_START=false`
- stable `STORAGE_ENCRYPTION_KEY`
- signer funded with native gas token on every chain the relayer will submit to

## How the ClearMacro Provider app uses this

- The **OpenZeppelin Relayer** is the source of transaction submission and status polling.
- At startup the **ClearMacro Provider** calls the relayer HTTP API, lists relayers, resolves each relayer’s EVM `chainId` from network metadata (`eip155:*` or `evm:<id>`), and **binds exactly one** active relayer per chain listed in `config/provider.json`. Provider config holds chain policy only; relayer IDs come from this discovery step. Each configured chain must map to exactly one active relayer; ambiguous or empty matches fail startup.
- Registry `rpcUrls` feed the **app** (digest, signature validation, synchronous preflight, readiness). Submission RPCs and relayer networks are configured under **this** `config/oz-relayer` tree.
