import { hashTypedData } from "viem";
import { SafeMessageUnsupportedError } from "./errors.js";

export function parseTypedDataMessage(message: unknown): Parameters<typeof hashTypedData>[0] {
  if (typeof message === "string") {
    try {
      return parseTypedDataMessage(JSON.parse(message) as unknown);
    } catch {
      throw new SafeMessageUnsupportedError("Safe message payload is not valid JSON typed data.");
    }
  }
  if (!message || typeof message !== "object") {
    throw new SafeMessageUnsupportedError("Safe message payload is missing typed data.");
  }
  const record = message as Record<string, unknown>;
  const domain = record.domain;
  const types = record.types;
  const primaryType = record.primaryType;
  const messageBody = record.message;
  if (!domain || typeof domain !== "object" || !types || typeof types !== "object") {
    throw new SafeMessageUnsupportedError("Safe message payload is missing EIP-712 domain or types.");
  }
  if (typeof primaryType !== "string" || !primaryType) {
    throw new SafeMessageUnsupportedError("Safe message payload is missing EIP-712 primaryType.");
  }
  if (!messageBody || typeof messageBody !== "object") {
    throw new SafeMessageUnsupportedError("Safe message payload is missing EIP-712 message body.");
  }
  return {
    domain: domain as Parameters<typeof hashTypedData>[0]["domain"],
    types: types as Parameters<typeof hashTypedData>[0]["types"],
    primaryType,
    message: messageBody as Parameters<typeof hashTypedData>[0]["message"],
  };
}

export function hashSafeMessageDigest(message: unknown): string {
  return hashTypedData(parseTypedDataMessage(message));
}
