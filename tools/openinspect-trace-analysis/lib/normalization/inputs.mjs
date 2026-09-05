import { sha256Bytes } from "../hash.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function normalizedInputFingerprint(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value)));
}

export function textIdentity(value) {
  if (typeof value !== "string") return null;
  return {
    sha256: sha256Bytes(Buffer.from(value)),
    bytes: Buffer.byteLength(value, "utf8"),
  };
}
