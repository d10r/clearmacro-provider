import { encodeAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { clearMacroPayloadAbiParameters } from "../../src/validation/clearmacro.js";
import {
  computePermit2Digest,
  normalizePermit2Request,
  PERMIT2_ADDRESS,
  ZERO_ADDRESS,
} from "../../src/chain/permit2.js";
import { clearMacroForwarderV1Abi } from "../../src/chain/clearMacroForwarderV1Abi.js";

export const TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20";
export const TEST_FORWARDER_ADDRESS =
  "0x0000000000000000000000000000000000000001" as const;

export function buildClearMacroParams(overrides?: {
  domain?: string;
  provider?: string;
  macroContract?: `0x${string}`;
  validAfter?: bigint;
  validBefore?: bigint;
  nonce?: bigint;
  actionParams?: `0x${string}`;
}) {
  return encodeAbiParameters(clearMacroPayloadAbiParameters, [
    {
      action: { params: overrides?.actionParams ?? "0x1234" },
      security: {
        domain: overrides?.domain ?? "test",
        macroContract: overrides?.macroContract ?? "0x0000000000000000000000000000000000000002",
        provider: overrides?.provider ?? "macros.superfluid.eth",
        validAfter: overrides?.validAfter ?? 0n,
        validBefore: overrides?.validBefore ?? 0n,
        nonce: overrides?.nonce ?? 1n,
      },
    },
  ]);
}

export async function buildRelayPayload(overrides?: {
  signer?: `0x${string}`;
  signature?: `0x${string}`;
  kind?: "clearMacroV1";
  payload?: `0x${string}`;
  chainId?: number;
  macroAddress?: `0x${string}`;
  signerAddress?: `0x${string}`;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
  clientRequestId?: string;
  metadata?: Record<string, string>;
}) {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const digest = (`0x${"11".repeat(32)}`) as `0x${string}`;
  const signature = overrides?.signature ?? ((await account.sign({ hash: digest })) as `0x${string}`);
  return {
    kind: overrides?.kind ?? "clearMacroV1",
    chainId: overrides?.chainId ?? 1,
    macroAddress: overrides?.macroAddress ?? "0x0000000000000000000000000000000000000002",
    signerAddress: overrides?.signerAddress ?? overrides?.signer ?? account.address,
    payload: overrides?.payload ?? (buildClearMacroParams() as `0x${string}`),
    signature,
    value: overrides?.value,
    forceExecuteAfterPreflightRevert: overrides?.forceExecuteAfterPreflightRevert,
    clientRequestId: overrides?.clientRequestId,
    metadata: overrides?.metadata,
  };
}

export function buildPermit2Request(overrides?: {
  token?: `0x${string}`;
  amount?: string;
  nonce?: string;
  deadline?: string;
  spender?: `0x${string}`;
  upgradeSuperToken?: `0x${string}`;
  signature?: `0x${string}`;
}) {
  return {
    permit: {
      permitted: {
        token: overrides?.token ?? "0x00000000000000000000000000000000000000cc",
        amount: overrides?.amount ?? "1000000",
      },
      nonce: overrides?.nonce ?? "123",
      deadline: overrides?.deadline ?? "4102444800",
    },
    spender: overrides?.spender ?? TEST_FORWARDER_ADDRESS,
    upgradeSuperToken: overrides?.upgradeSuperToken ?? ZERO_ADDRESS,
    signature: overrides?.signature ?? ("0x1234" as `0x${string}`),
  };
}

export async function buildPermit2RelayPayload(overrides?: {
  kind?: "clearMacroPermit2V1";
  payload?: `0x${string}`;
  chainId?: number;
  macroAddress?: `0x${string}`;
  signerAddress?: `0x${string}`;
  permit2?: ReturnType<typeof buildPermit2Request>;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
}) {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  return {
    kind: overrides?.kind ?? "clearMacroPermit2V1",
    chainId: overrides?.chainId ?? 1,
    macroAddress: overrides?.macroAddress ?? "0x0000000000000000000000000000000000000002",
    signerAddress: overrides?.signerAddress ?? account.address,
    payload: overrides?.payload ?? (buildClearMacroParams() as `0x${string}`),
    permit2: overrides?.permit2 ?? buildPermit2Request(),
    value: overrides?.value,
    forceExecuteAfterPreflightRevert: overrides?.forceExecuteAfterPreflightRevert,
  };
}

const permit2DomainSeparatorAbi = [
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** Builds a witness-only Permit2 relay body with a real EOA signature over the on-chain digest. */
export async function buildWitnessOnlyPermit2RelayPayload(input: {
  publicClient: PublicClient;
  forwarderAddress: Address;
  macroAddress: Address;
  payload: Hex;
  signer: PrivateKeyAccount;
  chainId: number;
  spender?: Address;
  token?: Address;
  permitNonce?: string;
  permitDeadline?: string;
  permitAmount?: string;
}) {
  return buildPermit2RelayPayloadWithUpgrade({
    ...input,
    upgradeSuperToken: ZERO_ADDRESS as Address,
    spender: input.spender ?? input.forwarderAddress,
  });
}

/** Builds an implied-upgrade Permit2 relay body (spender must be the forwarder). */
export async function buildImpliedUpgradePermit2RelayPayload(input: {
  publicClient: PublicClient;
  forwarderAddress: Address;
  macroAddress: Address;
  payload: Hex;
  signer: PrivateKeyAccount;
  chainId: number;
  underlyingToken: Address;
  wrapperSuperToken: Address;
  permitAmount: string;
  permitNonce?: string;
  permitDeadline?: string;
}) {
  return buildPermit2RelayPayloadWithUpgrade({
    publicClient: input.publicClient,
    forwarderAddress: input.forwarderAddress,
    macroAddress: input.macroAddress,
    payload: input.payload,
    signer: input.signer,
    chainId: input.chainId,
    upgradeSuperToken: input.wrapperSuperToken,
    spender: input.forwarderAddress,
    token: input.underlyingToken,
    permitAmount: input.permitAmount,
    ...(input.permitNonce !== undefined ? { permitNonce: input.permitNonce } : {}),
    ...(input.permitDeadline !== undefined ? { permitDeadline: input.permitDeadline } : {}),
  });
}

async function buildPermit2RelayPayloadWithUpgrade(input: {
  publicClient: PublicClient;
  forwarderAddress: Address;
  macroAddress: Address;
  payload: Hex;
  signer: PrivateKeyAccount;
  chainId: number;
  upgradeSuperToken: Address;
  spender: Address;
  token?: Address;
  permitNonce?: string;
  permitDeadline?: string;
  permitAmount?: string;
}) {
  const upgradeSuperToken = input.upgradeSuperToken;
  const witness = (await input.publicClient.readContract({
    address: input.forwarderAddress,
    abi: clearMacroForwarderV1Abi,
    functionName: "getPermit2WitnessStructHash",
    args: [input.macroAddress, input.payload, upgradeSuperToken],
  })) as Hex;
  const witnessTypeString = await input.publicClient.readContract({
    address: input.forwarderAddress,
    abi: clearMacroForwarderV1Abi,
    functionName: "getPermit2WitnessTypeString",
    args: [input.macroAddress, input.payload],
  });
  const domainSeparator = (await input.publicClient.readContract({
    address: PERMIT2_ADDRESS,
    abi: permit2DomainSeparatorAbi,
    functionName: "DOMAIN_SEPARATOR",
  })) as Hex;
  const permit2Request = buildPermit2Request({
    spender: input.spender,
    upgradeSuperToken,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.permitNonce !== undefined ? { nonce: input.permitNonce } : {}),
    ...(input.permitDeadline !== undefined ? { deadline: input.permitDeadline } : {}),
    ...(input.permitAmount !== undefined ? { amount: input.permitAmount } : {}),
  });
  const stored = normalizePermit2Request(permit2Request);
  const digest = computePermit2Digest({
    permit2: stored,
    owner: input.signer.address,
    witness,
    witnessTypeString,
    domainSeparator,
  });
  const signature = (await input.signer.sign({ hash: digest })) as Hex;
  return {
    kind: "clearMacroPermit2V1" as const,
    chainId: input.chainId,
    macroAddress: input.macroAddress,
    signerAddress: input.signer.address,
    payload: input.payload,
    permit2: {
      ...permit2Request,
      signature,
    },
    value: "0",
  };
}
