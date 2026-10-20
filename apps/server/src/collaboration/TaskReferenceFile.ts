import * as Clock from "effect/Clock";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ChatFileAttachment } from "@t3tools/contracts";
import { isPlainTaskReference, isPlainReferenceText } from "@t3tools/shared/taskReferenceFile";
import {
  resolveAttachmentPath,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  PENDING_ATTACHMENT_MAX_AGE_MS,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
export class TaskReferenceFileDenied extends Schema.TaggedError<TaskReferenceFileDenied>()(
  "TaskReferenceFileDenied",
  { reason: Schema.String },
) {}
export const readTaskReferenceFile = Effect.fn("TaskReferenceFile.read")(function* (
  attachment: ChatFileAttachment,
  expectedSha256: string,
) {
  if (!isPlainTaskReference(attachment))
    return yield* new TaskReferenceFileDenied({
      reason: "Only one ordinary UTF-8 text/plain .txt file is supported.",
    });
  const configOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fsOption = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isNone(configOption) || Option.isNone(fsOption))
    return yield* new TaskReferenceFileDenied({ reason: "Reference file store unavailable." });
  const config = configOption.value;
  const fs = fsOption.value;
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  if (!path)
    return yield* new TaskReferenceFileDenied({ reason: "Reference file identity unavailable." });
  const info = yield* fs.stat(path);
  if (info.type !== "File" || Number(info.size) !== attachment.sizeBytes)
    return yield* new TaskReferenceFileDenied({
      reason: "Reference file missing or size changed.",
    });
  if (parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT) {
    const mtime = Option.getOrUndefined(info.mtime)?.getTime();
    if (
      mtime === undefined ||
      (yield* Clock.currentTimeMillis) - mtime > PENDING_ATTACHMENT_MAX_AGE_MS
    )
      return yield* new TaskReferenceFileDenied({ reason: "Pending reference file expired." });
  }
  const bytes = yield* fs.readFile(path);
  if (
    bytes.length !== attachment.sizeBytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  )
    return yield* new TaskReferenceFileDenied({ reason: "Reference file content changed." });
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => new TaskReferenceFileDenied({ reason: "Reference file is not UTF-8 text." }),
  });
  if (!isPlainReferenceText(text))
    return yield* new TaskReferenceFileDenied({
      reason: "Reference file contains binary control bytes.",
    });
  return path;
});
