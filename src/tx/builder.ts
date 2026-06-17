import { encodeFunctionData } from "viem";
import { clearMacroForwarderV1Abi } from "../chain/clearMacroForwarderV1Abi.js";
import type { ClearMacroForwarderCall } from "../chain/readiness.js";
import type { Permit2Context } from "../chain/permit2.js";

export { clearMacroForwarderV1Abi };

/** Subset of {@link ClearMacroForwarderCall} plus signature for `runMacro` calldata. */
export type RunMacroCalldataInput = Pick<
  ClearMacroForwarderCall,
  "macro" | "encodedPayload" | "signer"
> & {
  signature: string;
};

export function buildRunMacroCalldata(input: RunMacroCalldataInput): string {
  return encodeFunctionData({
    abi: clearMacroForwarderV1Abi,
    functionName: "runMacro",
    args: [
      input.macro as `0x${string}`,
      input.encodedPayload as `0x${string}`,
      input.signer as `0x${string}`,
      input.signature as `0x${string}`,
    ],
  });
}

export function buildRunPermit2AndMacroCalldata(input: {
  permit2Context: Permit2Context;
  macro: string;
  encodedPayload: string;
}): string {
  return encodeFunctionData({
    abi: clearMacroForwarderV1Abi,
    functionName: "runPermit2AndMacro",
    args: [
      input.permit2Context,
      input.macro as `0x${string}`,
      input.encodedPayload as `0x${string}`,
    ],
  });
}
