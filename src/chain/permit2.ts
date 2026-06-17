import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from "viem";

export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

const TOKEN_PERMISSIONS_TYPEHASH = keccak256(
  toBytes("TokenPermissions(address token,uint256 amount)"),
);

const PERMIT_WITNESS_TRANSFER_FROM_STUB =
  "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

export type Permit2RequestInput = {
  permit: {
    permitted: {
      token: string;
      amount: string;
    };
    nonce: string;
    deadline: string;
  };
  spender: string;
  upgradeSuperToken: string;
  signature: string;
};

/** Canonical Permit2 fields persisted in `permit2_json`. */
export type StoredPermit2Json = ReturnType<typeof normalizePermit2Request>;

export type Permit2Context = {
  permit: {
    permitted: {
      token: Address;
      amount: bigint;
    };
    nonce: bigint;
    deadline: bigint;
  };
  owner: Address;
  witness: Hex;
  witnessTypeString: string;
  signature: Hex;
  spender: Address;
  upgradeSuperToken: Address;
};

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function isImpliedUpgradeMode(upgradeSuperToken: string): boolean {
  return upgradeSuperToken.toLowerCase() !== ZERO_ADDRESS;
}

export function normalizePermit2Request(
  input: Permit2RequestInput,
) {
  return {
    permit: {
      permitted: {
        token: input.permit.permitted.token.toLowerCase(),
        amount: input.permit.permitted.amount,
      },
      nonce: input.permit.nonce,
      deadline: input.permit.deadline,
    },
    spender: input.spender.toLowerCase(),
    upgradeSuperToken: input.upgradeSuperToken.toLowerCase(),
    signature: input.signature,
  };
}

export function parseStoredPermit2Json(value: string): StoredPermit2Json {
  const parsed = JSON.parse(value) as StoredPermit2Json;
  if (
    !parsed?.permit?.permitted?.token ||
    !parsed.permit.permitted.amount ||
    !parsed.permit.nonce ||
    !parsed.permit.deadline ||
    !parsed.spender ||
    !parsed.upgradeSuperToken ||
    !parsed.signature
  ) {
    throw new Error("Invalid stored permit2_json");
  }
  return parsed;
}

function hashTokenPermissions(token: Address, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        {
          type: "tuple",
          components: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
      ],
      [TOKEN_PERMISSIONS_TYPEHASH, { token, amount }],
    ),
  );
}

function hashPermitWitnessTransferFromType(witnessTypeString: string): Hex {
  return keccak256(
    encodePacked(
      ["string", "string"],
      [PERMIT_WITNESS_TRANSFER_FROM_STUB, witnessTypeString],
    ),
  );
}

export function computePermit2Digest(input: {
  permit2: StoredPermit2Json;
  owner: string;
  witness: Hex;
  witnessTypeString: string;
  domainSeparator: Hex;
}): Hex {
  const typeHash = hashPermitWitnessTransferFromType(input.witnessTypeString);
  const tokenPermissionsHash = hashTokenPermissions(
    input.permit2.permit.permitted.token as Address,
    BigInt(input.permit2.permit.permitted.amount),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        typeHash,
        tokenPermissionsHash,
        input.permit2.spender as Address,
        BigInt(input.permit2.permit.nonce),
        BigInt(input.permit2.permit.deadline),
        input.witness,
      ],
    ),
  );
  return keccak256(
    encodePacked(
      ["bytes1", "bytes1", "bytes32", "bytes32"],
      ["0x19", "0x01", input.domainSeparator, structHash],
    ),
  );
}

export function buildPermit2Context(input: {
  permit2: StoredPermit2Json;
  owner: string;
  witness: Hex;
  witnessTypeString: string;
}): Permit2Context {
  return {
    permit: {
      permitted: {
        token: input.permit2.permit.permitted.token as Address,
        amount: BigInt(input.permit2.permit.permitted.amount),
      },
      nonce: BigInt(input.permit2.permit.nonce),
      deadline: BigInt(input.permit2.permit.deadline),
    },
    owner: input.owner as Address,
    witness: input.witness,
    witnessTypeString: input.witnessTypeString,
    signature: input.permit2.signature as Hex,
    spender: input.permit2.spender as Address,
    upgradeSuperToken: input.permit2.upgradeSuperToken as Address,
  };
}
