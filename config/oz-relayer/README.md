# OpenZeppelin Relayer Config

This directory is mounted into the OpenZeppelin Relayer container at `/app/config`.

The checked-in files are safe templates for local wiring. Before using a real chain, provide production relayer IDs, network RPC URLs, and signer configuration here. Keep signer keystores under `config/oz-relayer/keys/`; JSON keystores in that directory are ignored by git.

Required runtime properties:

- `REPOSITORY_STORAGE_TYPE=redis`
- `RESET_STORAGE_ON_START=false`
- stable `STORAGE_ENCRYPTION_KEY`
- signer funded with native gas token on every enabled chain

The ClearMacro Provider app references relayers by `ozRelayerId` from `config/registry.json`.
