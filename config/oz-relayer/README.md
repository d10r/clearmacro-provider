# OpenZeppelin Relayer Config

This directory is mounted into the OpenZeppelin Relayer container at `/app/config`.

The checked-in files are safe templates for local wiring. Before production, provide real network definitions, RPC URLs, and signer configuration here. Put production signer keystores in `config/oz-relayer/keys/` (that directory is gitignored so keys never ship in the repo).

## Docker bind mounts and keystore permissions

Compose mounts this directory at `/app/config` **read-only**. Keystore JSON from `pnpm run prod:init` is typically **`0600`** and owned by your login user. The OpenZeppelin Relayer container must run **as that same numeric UID/GID**, or startup will fail with a keystore `Permission denied` panic. Set **`OZ_RELAYER_UID`** and **`OZ_RELAYER_GID`** in `.env` to `id -u` / `id -g` on the host that owns `config/oz-relayer/keys/` (see `compose.prod.yaml` `user:` on the `oz-relayer` service). On Linux/macOS, **`pnpm run prod:init`** appends these to `.env` from `getuid`/`getgid` when they are missing. Local **`compose.yaml`** defaults to `1000:1000` if unset.

## Generate `networks/evm.json` from the registry

From the repo root (after `pnpm install`), `@superfluid-finance/metadata` supplies chain names, testnet flag, native symbol, and public RPC fallbacks; your `config/provider.json` lists which chains to include and should set **`rpcUrls`** first when you use private endpoints.

```bash
pnpm run oz:gen:networks
# optional: registry path and dry-run
pnpm run oz:gen:networks -- path/to/provider.json --dry-run
# optional: rewrite config.json relayers[] to match (keeps signers, notifications, plugins)
pnpm run oz:gen:networks -- --update-config
```

**Local Anvil:** use `chainId` **31337** in the registry with `rpcUrls` (for example `http://anvil:8545` in Docker). That yields the `localhost-anvil` network block without Superfluid metadata.

**Still manual:** `config.json` signers and keystores, compose/env secrets (`STORAGE_ENCRYPTION_KEY`, API keys, passphrase). With `--update-config`, `signer_id` is taken from the first existing relayer or **`OZ_RELAYER_SIGNER_ID`**.

Required runtime properties:

- `REPOSITORY_STORAGE_TYPE=redis`
- `RESET_STORAGE_ON_START=false`
- stable `STORAGE_ENCRYPTION_KEY`
- signer funded with native gas token on every chain the relayer will submit to

## How the ClearMacro Provider app uses this

- The **OpenZeppelin Relayer** is the source of transaction submission and status polling.
- At startup the **ClearMacro Provider** calls the relayer HTTP API, lists relayers, resolves each relayer’s EVM `chainId` from network metadata (`eip155:*` or `evm:<id>`), and **binds exactly one** active relayer per chain listed in `config/provider.json`. Provider config holds chain policy only; relayer IDs come from this discovery step. Each configured chain must map to exactly one active relayer; ambiguous or empty matches fail startup.
- Registry `rpcUrls` feed the **app** (digest, signature validation, synchronous preflight, readiness). Submission RPCs and relayer networks are configured under **this** `config/oz-relayer` tree.
