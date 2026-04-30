import { decodeAbiParameters, recoverAddress } from "viem";

export const clearMacroPayloadAbiParameters = [
  {
    name: "payload",
    type: "tuple",
    components: [
      {
        name: "action",
        type: "tuple",
        components: [{ name: "params", type: "bytes" }],
      },
      {
        name: "security",
        type: "tuple",
        components: [
          { name: "domain", type: "string" },
          { name: "macroContract", type: "address" },
          { name: "provider", type: "string" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export type DecodedPayload = {
  domain: string;
  macroContract: string;
  provider: string;
  validAfter: bigint;
  validBefore: bigint;
  nonce: bigint;
};

export function decodeClearMacroPayload(params: string): DecodedPayload {
  const [payload] = decodeAbiParameters(clearMacroPayloadAbiParameters, params as `0x${string}`);
  return {
    domain: payload.security.domain,
    macroContract: payload.security.macroContract.toLowerCase(),
    provider: payload.security.provider,
    validAfter: payload.security.validAfter,
    validBefore: payload.security.validBefore,
    nonce: payload.security.nonce,
  };
}

export async function validateEoaSignature(input: {
  expectedSigner: string;
  digest: string;
  signature: string;
}): Promise<boolean> {
  try {
    const recovered = await recoverAddress({
      hash: input.digest as `0x${string}`,
      signature: input.signature as `0x${string}`,
    });
    return recovered.toLowerCase() === input.expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

