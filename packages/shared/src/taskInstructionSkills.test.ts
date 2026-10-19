import { expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import {
  TaskInstructionSkillReview,
  TaskFirstLaunch,
  CommandId,
  MessageId,
  ThreadId,
  type TaskInstructionSkillModule,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  taskInstructionSkillModules,
  taskInstructionSkillRef,
  resolveTaskInstructionSkill,
  taskInstructionSkillBinding,
  verifyTaskInstructionSkillReview,
  taskInstructionSkillText,
} from "./taskInstructionSkills.ts";
const decodeProof = Schema.decodeUnknownSync(TaskInstructionSkillReview);
const decodeLaunch = Schema.decodeUnknownSync(TaskFirstLaunch);
it.each(taskInstructionSkillModules())(
  "hashes actual UTF-8 body and resolves only the code-owned $id version",
  (module) => {
    const ref = taskInstructionSkillRef(module);
    expect(ref.contentSha256).toBe(
      NodeCrypto.createHash("sha256").update(module.body, "utf8").digest("hex"),
    );
    expect(resolveTaskInstructionSkill(ref)).toEqual(module);
    expect(taskInstructionSkillText(module)).toContain(module.body);
    expect(module.tools).toEqual([]);
    expect(module.permissions).toEqual([]);
    expect(module.grantsAccess).toBe(false);
  },
);
it("rejects body/version/metadata from a different code snapshot instead of substituting current text", () => {
  const source = taskInstructionSkillModules()[0]!;
  const altered = { ...source, body: source.body + "\nDifferent source snapshot: café." };
  const ref = taskInstructionSkillRef(altered);
  expect(ref.contentSha256).not.toBe(taskInstructionSkillRef(source).contentSha256);
  expect(() => resolveTaskInstructionSkill(ref)).toThrow();
  const changedExpectation = taskInstructionSkillRef({
    ...source,
    inputExpectation: "Different input expectation",
  });
  expect(changedExpectation.contentSha256).toBe(taskInstructionSkillRef(source).contentSha256);
  expect(changedExpectation.moduleSha256).not.toBe(taskInstructionSkillRef(source).moduleSha256);
  expect(() => resolveTaskInstructionSkill(changedExpectation)).toThrow();
  expect(() => resolveTaskInstructionSkill({ ...ref, version: "2.0.0" as "1.0.0" })).toThrow();
});
it.each([
  { permissions: ["network"] },
  { tools: ["shell"] },
  { grantsAccess: true },
  { execute: "code" },
  { body: "x".repeat(2001) },
])("rejects permission-bearing or expanded code-owned descriptors %j", (extra) => {
  expect(() =>
    taskInstructionSkillRef({
      ...taskInstructionSkillModules()[0]!,
      ...extra,
    } as unknown as TaskInstructionSkillModule),
  ).toThrow();
});
it.each([
  { body: "client body" },
  { permissions: ["network"] },
  { tools: ["shell"] },
  { execute: "script" },
])("rejects extra instruction review fields %j", (extra) => {
  const proof = {
    module: taskInstructionSkillRef(taskInstructionSkillModules()[0]!),
    actorId: "actor",
    reviewedAt: "2026-10-19T00:00:00.000Z",
    expiresAt: "2026-10-19T00:05:00.000Z",
    bindingSha256: "0".repeat(64),
  };
  expect(() => decodeProof({ ...proof, ...extra })).toThrow();
  expect(() => decodeProof({ ...proof, module: { ...proof.module, ...extra } })).toThrow();
});
it("legacy launch remains valid without selecting a module", () => {
  const legacy = {
    commandId: CommandId.make("legacy"),
    messageId: MessageId.make("legacy"),
    threadId: ThreadId.make("legacy"),
    reference: {
      environmentId: "env",
      projectId: "project",
      taskId: "task",
      threadUpdatedAt: "2026-10-19T00:00:00.000Z",
      threadSequence: 0,
    },
    contract: {
      revision: 1,
      goal: "Original goal",
      redirect: "Bounded",
      acceptance: "Human review",
      brake: { maxProviderStarts: 1, stopConditions: "Stop" },
    },
    text: "Original goal",
    routingMode: "manual",
    modelSelection: { instanceId: "codex", model: "exact" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  };
  const launch = decodeLaunch(legacy);
  expect(launch.instructionSkill).toBeUndefined();
  const binding = {
    module: taskInstructionSkillRef(taskInstructionSkillModules()[0]!),
    actorId: "actor",
    reviewedAt: "2026-10-19T00:00:00.000Z",
    expiresAt: "2026-10-19T00:05:00.000Z",
  };
  const reviewed = {
    ...launch,
    instructionSkill: { ...binding, bindingSha256: taskInstructionSkillBinding(launch, binding) },
  };
  expect(verifyTaskInstructionSkillReview(reviewed, "actor", "2026-10-19T00:01:00.000Z").id).toBe(
    binding.module.id,
  );
  expect(() =>
    verifyTaskInstructionSkillReview(reviewed, "actor", "2026-10-19T00:05:00.000Z"),
  ).toThrow();
  for (const field of ["reviewedAt", "expiresAt"] as const) {
    const malformed = { ...binding, [field]: "not-a-date" };
    const invalid = {
      ...launch,
      instructionSkill: {
        ...malformed,
        bindingSha256: taskInstructionSkillBinding(launch, malformed),
      },
    };
    expect(() =>
      verifyTaskInstructionSkillReview(invalid, "actor", "2026-10-19T00:01:00.000Z"),
    ).toThrow();
  }

  expect(() =>
    verifyTaskInstructionSkillReview(
      { ...reviewed, text: "Changed" },
      "actor",
      "2026-10-19T00:01:00.000Z",
    ),
  ).toThrow();
  expect(() =>
    verifyTaskInstructionSkillReview(
      { ...reviewed, modelSelection: { ...launch.modelSelection, model: "other" } },
      "actor",
      "2026-10-19T00:01:00.000Z",
    ),
  ).toThrow();
  expect(() =>
    verifyTaskInstructionSkillReview(reviewed, "other-actor", "2026-10-19T00:01:00.000Z"),
  ).toThrow();
});
