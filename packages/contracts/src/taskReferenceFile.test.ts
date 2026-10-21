import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { TaskFirstLaunch } from "./taskFirstLaunch.ts";
const attachment = {
  type: "file",
  id: "pending-00000000-0000-4000-8000-000000000001-txt",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};
const launch = {
  commandId: "file",
  messageId: "file",
  threadId: "thread",
  reference: {
    environmentId: "env",
    projectId: "project",
    taskId: "task",
    threadUpdatedAt: "2026-10-20T00:00:00Z",
    threadSequence: 0,
  },
  contract: {
    revision: 1,
    goal: "Read supplied notes",
    redirect: "Only supplied evidence",
    acceptance: "Owner checks",
    brake: { maxProviderStarts: 1, stopConditions: "Stop" },
  },
  text: "Summarize notes",
  routingMode: "manual",
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
it("first launch preserves a reviewed plaintext file binding without changing legacy launches", () => {
  const decode = Schema.decodeUnknownSync(TaskFirstLaunch);
  expect(decode(launch)).not.toHaveProperty("referenceFile");
  const referenceFile = {
    reviewId: "issued",
    source: attachment,
    attachment: { ...attachment, id: "thread-00000000-0000-4000-8000-000000000002-txt" },
    contentSha256: "a".repeat(64),
    actorId: "actor",
    reviewedAt: "2026-10-20T00:00:00Z",
    expiresAt: "2026-10-20T00:05:00Z",
    bindingSha256: "b".repeat(64),
  };
  expect(decode({ ...launch, referenceFile }).referenceFile).toEqual(referenceFile);
  expect(() =>
    decode({ ...launch, referenceFile: { ...referenceFile, execute: "code" } }),
  ).toThrow();
});
