import { encodeFunctionData } from "viem";

export const clearMacroForwarderV1Abi = [
  {
    type: "function",
    name: "runMacro",
    stateMutability: "payable",
    inputs: [
      { name: "macro", type: "address" },
      { name: "params", type: "bytes" },
      { name: "signer", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "getDigest",
    stateMutability: "view",
    inputs: [
      { name: "macro", type: "address" },
      { name: "params", type: "bytes" },
    ],
    outputs: [{ name: "digest", type: "bytes32" }],
  },
] as const;

export function buildRunMacroCalldata(input: {
  macro: string;
  params: string;
  signer: string;
  signature: string;
}): string {
  return encodeFunctionData({
    abi: clearMacroForwarderV1Abi,
    functionName: "runMacro",
    args: [input.macro as `0x${string}`, input.params as `0x${string}`, input.signer as `0x${string}`, input.signature as `0x${string}`],
  });
}

