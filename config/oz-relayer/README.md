# OpenZeppelin Relayer Config

This directory is mounted into the OpenZeppelin Relayer container at `/app/config`.

The checked-in files are safe templates for local wiring. Before production, provide real network definitions, RPC URLs, and signer configuration here. Put production signer keystores in `config/oz-relayer/keys/` (that directory is gitignored so keys never ship in the repo).

Required runtime properties:

- `REPOSITORY_STORAGE_TYPE=redis`
- `RESET_STORAGE_ON_START=false`
- stable `STORAGE_ENCRYPTION_KEY`
- signer funded with native gas token on every chain the relayer will submit to

## How the ClearMacro Provider app uses this

- The **OpenZeppelin Relayer** is the source of transaction submission and status polling.
- At startup the **ClearMacro Provider** calls the relayer HTTP API, lists relayers, resolves each relayer’s EVM `chainId` from network metadata (`eip155:*` or `evm:<id>`), and **binds exactly one** active relayer per chain listed in `config/registry.json`. Registry JSON holds chain policy only; relayer IDs come from this discovery step. The process requires a unique match per configured chain (startup errors if binding is ambiguous or missing).
- Registry `rpcUrls` feed the **app** (digest, signature validation, synchronous preflight, readiness). Submission RPCs and relayer networks are configured under **this** `config/oz-relayer` tree.
