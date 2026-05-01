export type RawOzReceipt = {
  transactionHash: string;
  blockNumber: string | number | bigint;
  blockHash?: string | undefined;
  status: string | number | bigint;
  gasUsed?: string | number | bigint | undefined;
};

export type NormalizedReceipt = {
  transactionHash: `0x${string}`;
  blockNumber: string;
  blockHash?: `0x${string}`;
  status: "success" | "reverted";
  gasUsed?: string;
};

function normalizeStatus(status: string | number | bigint): "success" | "reverted" {
  const s = typeof status === "bigint" ? status.toString() : String(status).toLowerCase();
  if (s === "0" || s === "0x0" || s === "false") {
    return "reverted";
  }
  if (s === "1" || s === "0x1" || s === "true") {
    return "success";
  }
  const n = Number(s);
  if (n === 0) {
    return "reverted";
  }
  if (n === 1) {
    return "success";
  }
  return "reverted";
}

function decimalString(value: string | number | bigint): string {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (value.startsWith("0x")) {
    return BigInt(value).toString(10);
  }
  return value;
}

export function normalizeOzReceipt(raw: RawOzReceipt): NormalizedReceipt {
  const status = normalizeStatus(raw.status);
  const out: NormalizedReceipt = {
    transactionHash: raw.transactionHash as `0x${string}`,
    blockNumber: decimalString(raw.blockNumber),
    status,
  };
  if (raw.blockHash) {
    out.blockHash = raw.blockHash as `0x${string}`;
  }
  if (raw.gasUsed !== undefined && raw.gasUsed !== null) {
    out.gasUsed = decimalString(raw.gasUsed);
  }
  return out;
}
