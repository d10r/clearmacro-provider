# Full Local Stack E2E Implementation Plan

## Goal

Implement one Docker-gated full local E2E test that exercises the real local protocol path:

```text
Anvil -> Superfluid test framework -> ClearMacroForwarderV1 -> test ClearMacro macro -> OpenZeppelin Relayer -> clearmacro-provider app -> worker -> terminal succeeded execution
```

This is the production-relevant local E2E. It replaces the need for a fake-forwarder Docker smoke test once it works.

## Non-Goals

- Do not use a forked chain for this task.
- Do not use `RelayerLikePreflightForwarder` as the final E2E forwarder.
- Do not remove or clean up existing mock-based smoke tests until the full local E2E passes reliably.
- Do not add this test to default `pnpm test`.
- Do not reintroduce `Idempotency-Key`, client-provided `forwarderAddress`, or nonce-based deduplication.

## Expected Command

The final test must run with:

```sh
RUN_STACK_E2E=1 pnpm run test:e2e:stack
```

Default test commands must continue to pass without Docker:

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

## High-Level Architecture

Use a phased startup. The provider app cannot start until the registry contains deployed contract addresses.

```text
1. Start Anvil only.
2. Deploy Superfluid test framework and ClearMacro test fixtures to Anvil.
3. Generate provider registry and OZ Relayer config from deployed addresses.
4. Start Redis, OZ Relayer, and provider app.
5. Submit a signed ClearMacro relay execution through provider HTTP API.
6. Let worker submit via OZ Relayer.
7. Poll provider API until succeeded.
8. Tear down compose project and temp files.
```

## Required Files

Implementation may add these files:

- `compose.e2e.yaml`
- `test/e2e/relay-stack.e2e.test.ts`
- `test/fixtures/docker-stack.ts`
- `test/fixtures/contracts/src/StackE2EClearMacro.sol`
- `test/fixtures/contracts/script/DeployFullStackE2E.s.sol`
- `test/fixtures/contracts/artifacts/...` if generated artifacts are committed
- `specs/operations.md` updates documenting the command

Use different names only if the purpose stays obvious.

## Solidity Dependency Setup

The root-level `ethereum-contracts/` directory is reference material only. Do not import Solidity directly from that path.

Use the linked local package dependency instead:

```json
"@superfluid-finance/ethereum-contracts": "link:/home/didi/src/sf/protocol-monorepo/packages/ethereum-contracts"
```

The dependency is expected to resolve at:

```text
node_modules/@superfluid-finance/ethereum-contracts
```

The Solidity sources also import OpenZeppelin through the `@openzeppelin-v5/` alias. Ensure the provider repo has `@openzeppelin/contracts` installed in `node_modules` as a dev dependency or transitive dependency. If it is missing, add it explicitly:

```sh
pnpm add -D "@openzeppelin/contracts@^5"
```

If the link is missing, run:

```sh
pnpm add -D "@superfluid-finance/ethereum-contracts@link:/home/didi/src/sf/protocol-monorepo/packages/ethereum-contracts"
```

Do not switch this to `file:` unless packaging has been verified. `file:` currently tries to pack the local package and can fail on missing package-file paths in the protocol monorepo checkout.

### Foundry Fixture Project

Use the existing fixture project:

```text
test/fixtures/contracts
```

Update `test/fixtures/contracts/foundry.toml` so the E2E deploy script can compile against package dependencies from the provider repo root.

Required settings:

```toml
[profile.default]
src = "src"
script = "script"
out = "out"
libs = ["lib"]
solc = "0.8.30"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200

remappings = [
  "@superfluid-finance/ethereum-contracts/=../../../node_modules/@superfluid-finance/ethereum-contracts/",
  "@openzeppelin-v5/=../../../node_modules/@openzeppelin/contracts/",
  "forge-std/=lib/forge-std/src/"
]
```

If compilation fails on semantic-money imports, add the local protocol-monorepo package as a linked dependency or remapping. Prefer a package/remapping over copying sources.

For the local protocol monorepo checkout, the likely remapping is:

```toml
"@superfluid-finance/solidity-semantic-money/=../../../node_modules/@superfluid-finance/solidity-semantic-money/"
```

If that package is not present in `node_modules`, add it via local link from:

```text
/home/didi/src/sf/protocol-monorepo/packages/solidity-semantic-money
```

The implementation must include a fast compile check:

```sh
forge build --root test/fixtures/contracts
```

This command must pass before implementing Docker orchestration.

## Contract Requirements

### Use Superfluid Framework Deployer

Use the Superfluid Foundry deployment utility from the local protocol copy:

```text
@superfluid-finance/ethereum-contracts/contracts/utils/SuperfluidFrameworkDeployer.t.sol
```

The deploy script must do the Foundry test-framework pattern:

```solidity
vm.etch(ERC1820RegistryCompiled.at, ERC1820RegistryCompiled.bin);

SuperfluidFrameworkDeployer deployer = new SuperfluidFrameworkDeployer();
deployer.deployTestFramework();
SuperfluidFrameworkDeployer.Framework memory sf = deployer.getFramework();
```

Use `sf.host` as the real `ISuperfluid host`.

### Deploy Real ClearMacroForwarderV1

Deploy the real forwarder, not the relayer-like mock:

```solidity
ClearMacroForwarderV1 forwarder = new ClearMacroForwarderV1(sf.host);
```

Use source from:

```text
@superfluid-finance/ethereum-contracts/contracts/utils/ClearMacroForwarderV1.sol
```

Do not use `RelayerLikePreflightForwarder` for the final full local E2E.

### Grant Provider Role

The forwarder authorizes non-self relayers through the Superfluid `SimpleACL` role:

```solidity
bytes32 role = keccak256(bytes(providerName));
IAccessControl(sf.host.getSimpleACL()).grantRole(role, relayerSigner);
```

The deploy script must grant `keccak256("macros.superfluid.eth")` to the OZ relayer signer used by the E2E.

The default relayer signer private key from `scripts/bootstrap-oz-anvil-keystore.ts` resolves to:

```text
0xa9F9Add7e644C15eA3596F8653c69d66Ff708dC7
```

If the test uses a different relayer signer, compute and pass that address explicitly.

### Test Macro

Create a minimal real `IClearMacro` implementation for E2E.

File:

```text
test/fixtures/contracts/src/StackE2EClearMacro.sol
```

Requirements:

- Implements `IClearMacro`.
- `getPrimaryTypeName(bytes)` returns a stable type name, e.g. `"StackE2E"`.
- `getActionTypeDefinition(bytes)` returns a valid EIP-712 `Action(...)` type definition.
- `getActionStructHash(bytes)` hashes the action params consistently with that type definition.
- `buildBatchOperations(ISuperfluid host, bytes params, address msgSender)` returns an empty `ISuperfluid.Operation[]`.
- `postCheck(ISuperfluid host, bytes params, address msgSender)` does not revert.

Recommended minimal action type:

```solidity
string constant ACTION_TYPE = "Action(bytes32 salt)";
bytes32 constant ACTION_TYPEHASH = keccak256(bytes(ACTION_TYPE));
```

Use `params = abi.encode(bytes32 salt)` and:

```solidity
function getActionStructHash(bytes memory params) external pure returns (bytes32) {
    bytes32 salt = abi.decode(params, (bytes32));
    return keccak256(abi.encode(ACTION_TYPEHASH, salt));
}
```

Do not make action params empty. A non-empty action param makes digest construction easier to verify and avoids accidental degenerate hashing mistakes.

Rationale:

- Empty operations still exercise real `ClearMacroForwarderV1` signature validation, provider ACL, nonce, validity window, and `host.forwardBatchCall` path.
- This keeps the test focused on provider/ClearMacro/Superfluid integration without requiring token/agreement setup.

If `host.forwardBatchCall(emptyOps)` reverts, adjust the macro to return one harmless valid host operation only after verifying the minimum required operation. Do not fall back to the fake forwarder without documenting why.

### Deploy Script Output

The deploy script must write a JSON file consumed by the Vitest test.

Pass the output path as an environment variable or script argument, for example:

```sh
E2E_DEPLOY_OUTPUT=/tmp/.../deploy-output.json forge script \
  --root test/fixtures/contracts \
  script/DeployFullStackE2E.s.sol:DeployFullStackE2E \
  --rpc-url http://127.0.0.1:${E2E_ANVIL_HOST_PORT} \
  --broadcast
```

The deploy script must write JSON after broadcasted transactions are complete. The Vitest test must fail clearly if the output file is missing or malformed.

Example output:

```json
{
  "chainId": 31337,
  "providerName": "macros.superfluid.eth",
  "host": "0x...",
  "simpleACL": "0x...",
  "forwarderAddress": "0x...",
  "macroAddress": "0x...",
  "relayerSigner": "0xa9F9Add7e644C15eA3596F8653c69d66Ff708dC7"
}
```

## Compose Requirements

Add or update `compose.e2e.yaml`.

### Services

Required services:

- `anvil`
- `redis`
- `oz-relayer`
- `app`

### Anvil

Requirements:

- Chain ID `31337`.
- Host-published port controlled by `${E2E_ANVIL_HOST_PORT}`.
- Internal RPC URL: `http://anvil:8545`.

Example command:

```text
anvil --host 0.0.0.0 --port 8545 --chain-id 31337 --code-size-limit 100000
```

The enlarged code size limit is intentional because the Superfluid test deployment includes large framework/deployer contracts.

### OZ Relayer

Requirements:

- Depends on `redis` and `anvil`.
- Uses generated temp config mounted into the container.
- Network RPC URL must be `http://anvil:8545`.
- Network config must contain `chain_id: 31337`.
- Exactly one active EVM relayer must match `chain_id: 31337`.
- `required_confirmations` should be `1` for test speed.
- The relayer signer must be the same address granted the provider role in `SimpleACL`.

Generated network entry example:

```json
{
  "network": "e2e-anvil",
  "type": "evm",
  "chain_id": 31337,
  "is_testnet": true,
  "required_confirmations": 1,
  "average_blocktime_ms": 1000,
  "symbol": "ETH",
  "rpc_urls": ["http://anvil:8545"]
}
```

### Provider App

Requirements:

- Built from this repo's `Dockerfile`.
- Host-published port controlled by `${E2E_APP_HOST_PORT}`.
- `PROVIDER_CONFIG_PATH` points to generated provider config mounted read-only.
- `OZ_RELAYER_URL=http://oz-relayer:8080`.
- `PROVIDER_NAME=macros.superfluid.eth`.
- `RELAYER_WORKER_ENABLED=true`.
- `RELAYER_WORKER_POLL_INTERVAL_MS=500` or similarly low.
- `API_AUTH_ENABLED=false`.
- Mount generated registry and database paths from the temp directory. Do not write E2E state into checked-in `config/` paths.

## Generated Provider Registry

After contract deployment and before app startup, write a temp registry:

```json
{
  "version": 1,
  "chains": [
    {
      "chainId": 31337,
      "forwarderAddress": "<deployed ClearMacroForwarderV1>",
      "rpcUrls": ["http://anvil:8545"],
      "allowedMacros": [
        {
          "domain": "e2e",
          "address": "<deployed StackE2EClearMacro>"
        }
      ]
    }
  ]
}
```

The app is inside Docker, so the registry RPC URL must be `http://anvil:8545`, not `127.0.0.1`.

## Test Payload And Signature

The test must create a real signed ClearMacro payload.

Steps:

1. Build the ClearMacro payload with:

```text
chainId = 31337
domain = "e2e"
macroContract = deployed StackE2EClearMacro
provider = "macros.superfluid.eth"
validAfter = 0
validBefore = 0
nonce = current forwarder.getNonce(signer, 0) or 0 for a fresh signer/key
action.params = abi.encode(bytes32 salt), matching `StackE2EClearMacro`
```

2. Call deployed `forwarder.getDigest(macroAddress, payload)` via host Anvil RPC.
3. Sign the digest with the request signer private key.
4. Submit:

```http
POST /v1/relay-executions
```

with:

```json
{
  "kind": "clearMacroV1",
  "chainId": 31337,
  "macroAddress": "<macro>",
  "signerAddress": "<signer>",
  "payload": "<payload>",
  "signature": "<signature>",
  "value": "0"
}
```

Do not use placeholder digests or fixture signatures in the full local E2E.

The deploy script grants provider ACL to the relayer signer, not to the request signer. The request signer only signs the digest and is passed as `signerAddress` in the API request.

## Vitest Flow

Implement in:

```text
test/e2e/relay-stack.e2e.test.ts
```

### Gating

If `RUN_STACK_E2E !== "1"`, skip the suite.

### Startup

1. Allocate random host ports for Anvil and app.
2. Create temp directory.
3. Start Anvil only.
4. Wait for `eth_chainId == 0x7a69`.
5. Run `forge build --root test/fixtures/contracts`.
6. Run Forge deploy script against host Anvil RPC.
7. Fund relayer signer if the deploy script did not already do so.
8. Generate registry and OZ config.
9. Start Redis, OZ Relayer, and app.
10. Wait for:

```text
GET /healthz -> 200
GET /readyz -> 200 { ready: true }
```

### Assertions

1. Capabilities:

```text
GET /v1/capabilities
```

Expected:

```ts
{
  providerName: "macros.superfluid.eth";
  chains: [{ chainId: 31337, forwarderAddress: deployedForwarder }];
}
```

Must not include macros, readiness, feature flags, state names, relayer IDs, or relayer status.

2. Create:

```text
POST /v1/relay-executions -> 202
```

Expected response:

```text
state = pending
terminal = false
forwarderAddress = deployedForwarder
macroAddress = deployedMacro
transaction absent
```

3. Poll:

```text
GET /v1/relay-executions/:id
```

until:

```text
state = succeeded
terminal = true
transaction.hash exists
receipt.status = success
```

Timeout: 60-120 seconds.

On failure, include recent `docker compose logs` in the assertion error.

### Teardown

Always run:

```sh
docker compose -p <project> -f compose.e2e.yaml down -v --remove-orphans
```

Remove temp directories after compose teardown.

## Verification Commands

After implementation:

```sh
pnpm run typecheck
forge build --root test/fixtures/contracts
pnpm test
RUN_STACK_E2E=1 pnpm run test:e2e:stack
pnpm run build
```

All must pass.

## Final Cleanup Step

Only after the full local E2E above passes reliably:

- Review any existing mock-based Docker stack smoke test.
- Remove it if it duplicates the full local E2E.
- Keep lower-level unit/integration tests that cover targeted failure modes.
- Do not remove the existing mock-based smoke earlier, because it may still help diagnose infrastructure while the full test is being built.

## Done Criteria

- The E2E deploys the Superfluid test framework locally via `SuperfluidFrameworkDeployer`.
- The E2E uses real `ClearMacroForwarderV1`.
- The E2E grants provider ACL role to the OZ relayer signer.
- The E2E submits through the provider HTTP API and OZ Relayer.
- The E2E reaches public `succeeded` with a success receipt.
- Default tests remain Docker-free.
- Mock-based Docker smoke cleanup is done only after the real E2E is green.
