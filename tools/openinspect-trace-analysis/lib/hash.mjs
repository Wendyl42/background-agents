import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashFile(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

export function fileSize(path) {
  return statSync(path).size;
}

export function fingerprintBundle(manifestText, hashesText) {
  return sha256Bytes(
    Buffer.concat([Buffer.from(manifestText), Buffer.from([0]), Buffer.from(hashesText)])
  );
}
