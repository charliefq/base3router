import { jointTaskInputBinding } from "@t3tools/shared/taskJointInputReview";
import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { TaskFirstLaunch, OrchestrationV2Command } from "@t3tools/contracts";
import { sha256Hex } from "@t3tools/shared/actionCanonical";
import {
  taskInstructionSkillModules,
  taskInstructionSkillRef,
  taskInstructionSkillText,
} from "@t3tools/shared/taskInstructionSkills";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
import { prepareTask } from "./testkit/taskReferenceFileFixture";
type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
function value<A>(r: { _tag: "Success"; value: A } | { _tag: "Failure"; cause: unknown }): A {
  if (r._tag !== "Success") throw new Error(String(r.cause));
  return r.value;
}
const start = (f: Fixture, marker: TaskFirstLaunch) =>
  f.start({
    commandId: marker.commandId,
    threadId: marker.threadId,
    message: {
      messageId: marker.messageId,
      role: "user",
      text: marker.text,
      attachments: marker.referenceFile ? [marker.referenceFile.source] : [],
    },
    modelSelection: marker.modelSelection,
    routingMode: marker.routingMode,
    dispatchMode: "start",
    runtimeMode: marker.runtimeMode,
    interactionMode: marker.interactionMode,
    taskFirstLaunch: marker,
  });
it.each(
  (["manual", "auto"] as const).flatMap((mode) =>
    [0, 1].map((moduleIndex) => ({ mode, moduleIndex })),
  ),
)(
  "$mode jointly reviews and delivers exact skill $moduleIndex and reference once",
  async ({ mode, moduleIndex }) => {
    await withTaskTransportFixture(async (f) => {
      const p = await prepareTask(f, `joint-${mode}-${moduleIndex}`, mode);
      const bytes = "Supplied untrusted evidence: café\n";
      const attachment = await f.uploadFile("joint-notes.txt", bytes);
      const module = taskInstructionSkillModules()[moduleIndex]!;
      const reviewed = value(
        await f.reviewReferenceFile({
          launch: p.launch,
          attachment,
          contentSha256: sha256Hex(bytes),
          module: taskInstructionSkillRef(module),
        }),
      );
      expect(reviewed.status).toBe("available");
      if (reviewed.status !== "available" || !reviewed.instructionSkill || !reviewed.module)
        throw new Error("No joint issuance");
      expect(await f.executionCounts()).toEqual({ runs: 0, grants: 0, outbox: 0, messages: 0 });
      expect((await f.inspect()).starts).toHaveLength(0);
      expect(reviewed.review.reviewId).toBe(reviewed.instructionSkill.reviewId);
      expect(reviewed.review.bindingSha256).toBe(reviewed.instructionSkill.bindingSha256);
      const marker = {
        ...p.launch,
        referenceFile: reviewed.review,
        instructionSkill: reviewed.instructionSkill,
      };
      if (mode === "auto")
        f.setProviders(
          f.providers.map((provider) => ({
            ...provider,
            models: [{ ...provider.models[0]!, slug: "aaa-joint-actual" }],
          })),
        );
      const results = await Promise.all([start(f, marker), start(f, marker)]);
      expect(results.some((r) => r._tag === "Success")).toBe(true);
      await f.settle(marker.messageId);
      const actual = await f.inspect();
      expect(actual.starts).toHaveLength(1);
      if (mode === "auto") expect(actual.starts[0]!.model).toBe("aaa-joint-actual");
      expect(actual.inputs[0]).toBe(marker.text + taskInstructionSkillText(module));
      expect(actual.fileReads).toEqual([
        { messageId: marker.messageId, attachment: reviewed.review.attachment, text: bytes },
      ]);
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === marker.threadId)!;
      expect(task.resultReadout).toMatchObject({
        status: "available",
        referenceFileDelivery: { status: "adapter-accepted" },
        instructionSkillDelivery: {
          status: "adapter-accepted",
          reviewId: reviewed.review.reviewId,
        },
      });
      expect(await f.executionCounts()).toMatchObject({ runs: 1, grants: 1, messages: 1 });
      const beforeReplay = await f.executionCounts();
      await start(f, marker);
      await f.flush();
      expect(await f.executionCounts()).toEqual(beforeReplay);
    });
  },
);

async function originalCommand(
  f: Fixture,
  marker: TaskFirstLaunch,
): Promise<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> {
  const command = (await f.inspect()).commands.find((c) => c.commandId === marker.commandId);
  if (!command || command.type !== "message.dispatch")
    throw new Error("No original message command");
  return command;
}
async function prepareJoint(f: Fixture, key: string, mode: "manual" | "auto" = "auto") {
  const p = await prepareTask(f, key, mode);
  const text = "Joint reference evidence: café\n";
  const attachment = await f.uploadFile("joint-notes.txt", text);
  const module = taskInstructionSkillModules()[0]!;
  const input = {
    launch: p.launch,
    attachment,
    contentSha256: sha256Hex(text),
    module: taskInstructionSkillRef(module),
  };
  const reviewed = value(await f.reviewReferenceFile(input));
  if (reviewed.status !== "available" || !reviewed.instructionSkill)
    throw new Error("Joint review unavailable");
  const marker = {
    ...p.launch,
    referenceFile: reviewed.review,
    instructionSkill: reviewed.instructionSkill,
  };
  return { ...p, input, text, module, attachment, marker };
}
function rehash(marker: TaskFirstLaunch): TaskFirstLaunch {
  const hash = jointTaskInputBinding(marker);
  return {
    ...marker,
    referenceFile: { ...marker.referenceFile!, bindingSha256: hash },
    instructionSkill: { ...marker.instructionSkill!, bindingSha256: hash },
  };
}
it.each([
  "mixed",
  "rehashed-mixed",
  "separate",
  "module",
  "bytes",
  "removed",
  "metadata",
  "text",
  "contract",
  "routing",
  "scope",
  "expiry",
  "session",
  "readonly",
  "revoked",
  "missing-skill",
  "missing-file",
  "unsupported",
  "non-text",
] as const)("joint input rejects changed %s before provider work", async (change) => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepareJoint(f, `joint-reject-${change}`);
    let marker: TaskFirstLaunch = p.marker;
    if (change === "mixed" || change === "rehashed-mixed") {
      const next = value(await f.reviewReferenceFile(p.input));
      if (next.status !== "available" || !next.instructionSkill)
        throw new Error("No second issuance");
      marker = { ...marker, instructionSkill: next.instructionSkill };
      if (change === "rehashed-mixed")
        marker = rehash({
          ...marker,
          instructionSkill: {
            ...marker.instructionSkill!,
            reviewId: marker.referenceFile!.reviewId,
            reviewedAt: marker.referenceFile!.reviewedAt,
            expiresAt: marker.referenceFile!.expiresAt,
          },
        });
    }
    if (change === "separate") {
      const file = value(
        await f.reviewReferenceFile({
          launch: p.launch,
          attachment: p.attachment,
          contentSha256: p.input.contentSha256,
        }),
      );
      const skill = value(
        await f.reviewInstructionSkill({ launch: p.launch, module: p.input.module }),
      );
      if (file.status !== "available" || skill.status !== "available")
        throw new Error("No separate reviews");
      marker = { ...p.launch, referenceFile: file.review, instructionSkill: skill.review };
    }
    if (change === "module")
      marker = rehash({
        ...marker,
        instructionSkill: {
          ...marker.instructionSkill!,
          module: taskInstructionSkillRef(taskInstructionSkillModules()[1]!),
        },
      });
    if (change === "bytes")
      await f.changeAttachment(p.attachment, "x".repeat(p.attachment.sizeBytes));
    if (change === "removed") await f.deleteFile(p.attachment.id);
    if (change === "metadata")
      marker = rehash({
        ...marker,
        referenceFile: {
          ...marker.referenceFile!,
          source: { ...marker.referenceFile!.source, name: "changed.txt" },
        },
      });
    if (change === "text") marker = rehash({ ...marker, text: "Changed original instructions" });
    if (change === "contract")
      marker = rehash({
        ...marker,
        contract: { ...marker.contract, acceptance: "Changed acceptance" },
      });
    if (change === "routing") marker = rehash({ ...marker, routingMode: "manual" });
    if (change === "scope")
      marker = rehash({
        ...marker,
        reference: { ...marker.reference, projectId: "other-project" },
      });
    if (change === "expiry")
      marker = rehash({
        ...marker,
        referenceFile: { ...marker.referenceFile!, expiresAt: "2020-01-01T00:00:00Z" },
        instructionSkill: { ...marker.instructionSkill!, expiresAt: "2020-01-01T00:00:00Z" },
      });
    if (change === "session" || change === "readonly") {
      await f.disconnect();
      await f.connect(change === "readonly" ? ["orchestration:read"] : undefined);
    }
    if (change === "revoked") await f.revokeCurrent();
    if (change === "missing-skill") {
      const { instructionSkill: _skill, ...rest } = marker;
      marker = rest;
    }
    if (change === "missing-file") {
      const { referenceFile: _file, ...rest } = marker;
      marker = rest;
    }
    if (change === "unsupported")
      f.setProviders(
        f.providers.map((provider) => ({
          ...provider,
          driver: ProviderDriverKind.make("claudeAgent"),
        })),
      );
    if (change === "non-text")
      f.setProviders(
        f.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            inputModalities: ["image" as const],
          })),
        })),
      );
    const before = await f.executionCounts();
    expect((await start(f, marker))._tag).toBe("Failure");
    await f.flush();
    expect((await f.inspect()).starts).toHaveLength(0);
    expect(await f.executionCounts()).toEqual(before);
  });
});
it("joint lost reply reconciles the original command after reconnect without replacement input", async () => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepareJoint(f, "joint-lost-reply");
    f.dropNextReply();
    const pending = start(f, p.marker);
    await Promise.race([
      f.awaitDroppedReply(),
      pending.then(() => {
        throw new Error("Reply not dropped");
      }),
    ]);
    await f.disconnect();
    await pending;
    await f.settle(p.marker.messageId);
    await f.connect();
    const command = await originalCommand(f, p.marker);
    const status = value(await f.launchStatus({ command }));
    expect(status).toMatchObject({
      status: "admitted",
      referenceFileDelivery: { status: "adapter-accepted" },
      instructionSkillDelivery: { status: "adapter-accepted" },
    });
    await f.deleteFile(p.attachment.id);
    const before = await f.executionCounts();
    expect((await f.dispatch(command))._tag).toBe("Success");
    await f.flush();
    expect(await f.executionCounts()).toEqual(before);
    expect((await f.inspect()).starts).toHaveLength(1);
  });
});
it("joint UNKNOWN remains correlated and cannot resend while the original native call is held", async () => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepareJoint(f, "joint-unknown");
    f.holdInput(p.marker.text + taskInstructionSkillText(p.module));
    value(await start(f, p.marker));
    await f.awaitHeldStart();
    try {
      const command = await originalCommand(f, p.marker);
      const before = value(await f.launchStatus({ command }));
      expect(before).toMatchObject({
        status: "admitted",
        referenceFileDelivery: { status: "unknown" },
        instructionSkillDelivery: { status: "unknown" },
      });
      await f.disconnect();
      await f.connect();
      expect(value(await f.launchStatus({ command }))).toEqual(before);
      value(await f.dispatch(command));
      expect((await f.inspect()).starts).toHaveLength(1);
    } finally {
      f.releaseHeldStart();
      await f.settle(p.marker.messageId);
    }
  });
});

it.each(["pending-file", "accepted-file", "accepted-skill"] as const)(
  "interruption at %s preserves honest partial joint delivery",
  async (stage) => {
    await withTaskTransportFixture(async (f) => {
      const p = await prepareJoint(f, `joint-partial-${stage}`);
      f.failJointEvidence(stage);
      value(await start(f, p.marker));
      await f.settle(p.marker.messageId);
      const command = await originalCommand(f, p.marker);
      const status = value(await f.launchStatus({ command }));
      expect(status.status).toBe("admitted");
      if (status.status !== "admitted") throw new Error("No original receipt");
      expect(status.referenceFileDelivery?.status).toBe(
        stage === "pending-file"
          ? undefined
          : stage === "accepted-file"
            ? "unknown"
            : "adapter-accepted",
      );
      expect(status.instructionSkillDelivery?.status).toBe(
        stage === "accepted-file" ? "adapter-accepted" : "unknown",
      );
      expect((await f.inspect()).starts).toHaveLength(stage === "pending-file" ? 0 : 1);
      const before = await f.executionCounts();
      await f.disconnect();
      await f.connect();
      expect(value(await f.launchStatus({ command }))).toEqual(status);
      value(await f.dispatch(command));
      await f.flush();
      expect(await f.executionCounts()).toEqual(before);
      expect((await f.inspect()).starts).toHaveLength(stage === "pending-file" ? 0 : 1);
    });
  },
);
it("mismatched skill review evidence cannot attest both joint inputs", async () => {
  await withTaskTransportFixture(async (f) => {
    const p = await prepareJoint(f, "joint-corrupt-delivery");
    value(await start(f, p.marker));
    await f.settle(p.marker.messageId);
    await f.corruptJointSkillDelivery(p.marker.threadId);
    const command = await originalCommand(f, p.marker);
    const status = value(await f.launchStatus({ command }));
    expect(status).toMatchObject({
      status: "admitted",
      referenceFileDelivery: { status: "adapter-accepted" },
    });
    if (status.status === "admitted") expect(status.instructionSkillDelivery).toBeUndefined();
    const readout = (await f.snapshot()).tasks.find(
      (t) => t.threadId === p.marker.threadId,
    )!.resultReadout;
    if (readout?.status !== "available") throw new Error("No result");
    expect(readout.referenceFileDelivery?.status).toBe("adapter-accepted");
    expect(readout.instructionSkillDelivery).toBeUndefined();
    expect((await f.inspect()).starts).toHaveLength(1);
  });
});
