import {
  isProviderAvailable,
  isProviderTaskExecutionCapable,
  TaskFirstLaunch,
  type TaskReferenceFileReview,
  type ChatFileAttachment,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { digestCanonical } from "./actionCanonical.ts";
const isTaskFirstLaunch = Schema.is(TaskFirstLaunch);
export function isPlainReferenceText(text: string) {
  if (text.startsWith("%PDF-")) return false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}
export const isPlainTaskReference = (a: ChatFileAttachment) =>
  a.type === "file" &&
  a.mimeType === "text/plain" &&
  /^[^/\\]+\.txt$/i.test(a.name) &&
  a.source === undefined;
export function taskReferenceFileBinding(
  launch: TaskFirstLaunch,
  proof: Omit<TaskReferenceFileReview, "bindingSha256">,
) {
  const { referenceFile: _file, ...base } = launch;
  return digestCanonical({ launch: base, ...proof });
}
export function verifyTaskReferenceFile(launch: TaskFirstLaunch, actorId: string, now: string) {
  const proof = launch.referenceFile;
  if (
    !isTaskFirstLaunch(launch) ||
    !proof ||
    launch.instructionSkill ||
    proof.actorId !== actorId ||
    !isPlainTaskReference(proof.source) ||
    !isPlainTaskReference(proof.attachment)
  )
    throw new Error("Reference file review unavailable.");
  const at = Date.parse(proof.reviewedAt),
    expiry = Date.parse(proof.expiresAt),
    time = Date.parse(now);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(at) ||
    !Number.isFinite(expiry) ||
    at > time ||
    expiry <= time ||
    expiry <= at ||
    expiry - at > 300000
  )
    throw new Error("Reference file review expired.");
  const { bindingSha256, ...binding } = proof;
  if (taskReferenceFileBinding(launch, binding) !== bindingSha256)
    throw new Error("Reference file input changed.");
  return proof;
}
// This slice uses the existing Codex path-based file transport. No capability is inferred for other drivers.
export const taskReferenceTargetAvailable = (
  provider: ServerProvider | undefined,
  target: ModelSelection,
) =>
  !!provider &&
  provider.instanceId === target.instanceId &&
  provider.driver === "codex" &&
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider) &&
  isProviderTaskExecutionCapable(provider) &&
  provider.models.some(
    (m) =>
      m.slug === target.model &&
      (m.inputModalities === undefined || m.inputModalities.includes("text")),
  );

export function taskReferenceDeliveryMatches(
  selection: import("@t3tools/contracts").TaskReferenceFileReview | undefined,
  delivery: import("@t3tools/contracts").TaskReferenceFileDelivery | undefined,
  identity: {
    runId: string;
    attemptId: string | null;
    messageId: string;
    modelSelection: ModelSelection;
  },
) {
  return (
    !!selection &&
    !!delivery &&
    delivery.reviewId === selection.reviewId &&
    delivery.contentSha256 === selection.contentSha256 &&
    digestCanonical(delivery.source) === digestCanonical(selection.source) &&
    digestCanonical(delivery.attachment) === digestCanonical(selection.attachment) &&
    delivery.runId === identity.runId &&
    delivery.attemptId === identity.attemptId &&
    delivery.messageId === identity.messageId &&
    digestCanonical(delivery.modelSelection) === digestCanonical(identity.modelSelection)
  );
}
