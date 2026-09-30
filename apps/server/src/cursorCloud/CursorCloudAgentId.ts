import * as NodeCrypto from "node:crypto";

/**
 * Stable namespace for Cursor Cloud agent IDs. Changing this would mint a
 * different `bc-<uuid>` for the same workflow dispatch identity.
 */
const NAMESPACE = Buffer.from("a1b2c3d4e5f6478899aabbccddeeff00", "hex");

const uuidV5 = (name: string): string => {
  const hash = NodeCrypto.createHash("sha1");
  hash.update(NAMESPACE);
  hash.update(name);
  const bytes = Buffer.from(hash.digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export const cursorCloudAgentIdFromDispatch = (input: {
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly dispatchId: string;
}): string =>
  `bc-${uuidV5(`${input.runId}/${input.stageId}/${input.attempt}/${input.dispatchId}`)}`;
