# Contract Artifacts

This directory contains deployable contract artifacts used by Docker-gated E2E tests.

## ClearMacroForwarderV1

Path:

```text
artifacts/ClearMacroForwarderV1.sol/ClearMacroForwarderV1.json
```

Source:

- Copied from a Foundry build artifact provided in `tmp/ClearMacroForwarderV1.sol/ClearMacroForwarderV1.json`.
- Solidity compiler: `0.8.30+commit.73712a01`.
- Bytecode SHA-256: `9c5aa4e65966dcc60306c4a60d1554e629c96d4dccc7c8ac2fdda417b16c278c`.

Usage:

- E2E deploy helpers should read `abi` and `bytecode.object` from this artifact.
- The artifact has no library link references.
- The constructor requires one `ISuperfluid host` address.

Do not edit this JSON artifact manually. Replace it with a fresh Foundry artifact when the upstream ClearMacro forwarder changes.
