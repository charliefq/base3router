import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Deterministic JSON canonicalization for ActionGate fingerprints.
 * Object keys sort by UTF-16 code units (`<`), not `localeCompare`.
 * This is not `JSON.stringify` of an object.
 */
export const canonicalizeJson = (value: unknown): string => {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError("non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new CanonicalizationError(`${typeof value} cannot be canonicalized`);
  }
  if (typeof value === "undefined") {
    throw new CanonicalizationError("undefined cannot be canonicalized");
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareUtf16);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",")}}`;
  }
  throw new CanonicalizationError("value cannot be canonicalized");
};

export const sha256Hex = (canonical: string): string =>
  Encoding.encodeHex(sha256(new TextEncoder().encode(canonical)));

export const digestCanonical = (value: unknown): string => sha256Hex(canonicalizeJson(value));
