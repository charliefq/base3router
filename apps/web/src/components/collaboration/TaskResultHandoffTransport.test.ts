import { expect, it } from "vite-plus/test";
import { CommandId, type OrchestrationV2Command } from "@t3tools/contracts";
import { resultHandoffInput } from "@t3tools/shared/taskResultHandoff";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
import { creation, send } from "./testkit/resultContinuationJourney";
import {
  acceptedHandoffSource as source,
  handoffDestination as destination,
  value,
} from "./testkit/resultHandoffJourney";
it.each(["manual", "auto"] as const)(
  "%s hands off full accepted output once into an independent root",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      const s = await source(f, `source-${mode}`),
        before = await f.executionCounts();
      const d = await destination(f, s.source, `destination-${mode}`, mode);
      expect(await f.executionCounts()).toEqual(before);
      const empty = value(await f.projection({ threadId: d.c.threadId }));
      expect(empty.runs).toHaveLength(0);
      expect(empty.messages).toHaveLength(0);
      expect(empty.thread.lineage).toMatchObject({
        rootThreadId: d.c.threadId,
        parentThreadId: null,
        relationshipToParent: null,
      });
      value(await f.create(d.c));
      if (mode === "auto")
        f.setProviders(
          f.providers.map((p) => ({
            ...p,
            models: [{ ...p.models[0]!, slug: "aaa-handoff-actual" }, ...p.models],
          })),
        );
      value(await send(f, d.m));
      await f.settle(d.m.messageId);
      const actual = await f.inspect();
      expect(actual.inputs).toEqual([
        "First attributable output",
        resultHandoffInput(d.m.text, s.source),
      ]);
      expect(actual.starts).toHaveLength(2);
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === d.c.threadId)!;
      expect(task.resultReadout).toMatchObject({
        status: "available",
        resultHandoffSelection: s.source,
        resultHandoffDelivery: {
          status: "adapter-accepted",
          runId: expect.any(String),
          attemptId: expect.any(String),
          messageId: d.m.messageId,
          modelSelection: { model: mode === "manual" ? "exact-second" : "aaa-handoff-actual" },
        },
      });
      expect(value(await f.projection({ threadId: s.c.threadId }))).toEqual(s.projection);
      const count = await f.executionCounts();
      await send(f, d.m);
      await f.flush();
      expect(await f.executionCounts()).toEqual(count);
      await f.disconnect();
      await f.connect();
      value(await f.create(d.c));
      expect((await f.inspect()).starts).toHaveLength(2);
    });
  },
  30000,
);

it("revalidates source full text inside the admission transaction after successful planning", async () => {
  await withTaskTransportFixture(async (f) => {
    const s = await source(f, "atomic-source"),
      d = await destination(f, s.source, "atomic-destination");
    f.holdContinuationCommit(d.m.commandId);
    const pending = send(f, d.m);
    try {
      const boundary = await Promise.race([
        f.awaitContinuationCommit(),
        pending.then(() => {
          throw new Error("No commit boundary");
        }),
      ]);
      expect(boundary.priorRunId).toBe(s.source.result.runId);
      const staged = await f.executionCounts();
      await f.alterLatestOutput(s.c.threadId, s.source.text + "changed beyond preview");
      f.releaseContinuationCommit();
      expect((await pending)._tag).toBe("Failure");
      await f.drain();
      expect(await f.eventsForCommand(d.m.commandId)).toEqual([]);
      expect(await f.executionCounts()).toEqual(staged);
      expect((await f.inspect()).starts).toHaveLength(1);
    } finally {
      f.releaseContinuationCommit();
    }
  });
}, 30000);

it("retains UNKNOWN for the exact native delivery without resending after reconnect", async () => {
  await withTaskTransportFixture(async (f) => {
    const s = await source(f, "unknown-source"),
      d = await destination(f, s.source, "unknown-destination");
    f.holdInput(resultHandoffInput(d.m.text, s.source));
    value(await send(f, d.m));
    await f.awaitHeldStart();
    try {
      const command = (await f.inspect()).commands.find(
        (c): c is Extract<OrchestrationV2Command, { type: "message.dispatch" }> =>
          c.type === "message.dispatch" && c.commandId === d.m.commandId,
      )!;
      const original = value(await f.launchStatus({ command }));
      expect(original).toMatchObject({
        status: "admitted",
        resultHandoffDelivery: { status: "unknown" },
      });
      await f.disconnect();
      await f.connect();
      expect(value(await f.launchStatus({ command }))).toEqual(original);
      value(await f.dispatch(command));
      expect((await f.inspect()).starts).toHaveLength(2);
    } finally {
      f.releaseHeldStart();
      await f.settle(d.m.messageId);
    }
  });
}, 30000);

it("recovers lost creation and launch replies using only the original command identities", async () => {
  await withTaskTransportFixture(async (f) => {
    const s = await source(f, "lost-source"),
      base = creation("lost-destination"),
      c = { ...base, taskCreationReview: { ...base.taskCreationReview!, resultHandoff: s.source } };
    f.dropNextReply();
    const creating = f.create(c);
    await Promise.race([
      f.awaitDroppedReply(),
      creating.then(() => {
        throw new Error("Creation reply not dropped");
      }),
    ]);
    await f.disconnect();
    await creating;
    await f.connect();
    expect(value(await f.creationStatus({ command: c }))).toMatchObject({ status: "committed" });
    const d = await destination(f, s.source, "lost-destination");
    f.dropNextReply();
    const starting = send(f, d.m);
    await Promise.race([
      f.awaitDroppedReply(),
      starting.then(() => {
        throw new Error("Start reply not dropped");
      }),
    ]);
    await f.disconnect();
    await starting;
    await f.settle(d.m.messageId);
    await f.connect();
    const command = (await f.inspect()).commands.find(
      (x): x is Extract<OrchestrationV2Command, { type: "message.dispatch" }> =>
        x.type === "message.dispatch" && x.commandId === d.m.commandId,
    )!;
    expect(value(await f.launchStatus({ command }))).toMatchObject({
      status: "admitted",
      resultHandoffDelivery: { status: "adapter-accepted" },
    });
    expect((await f.snapshot()).tasks).toHaveLength(2);
    expect((await f.inspect()).starts).toHaveLength(2);
  });
}, 30000);

it.each(["removed", "modified", "overflow", "unsupported", "ordinary-bypass"] as const)(
  "rejects %s destination handoff before native work",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const s = await source(f, `gate-source-${kind}`),
        d = await destination(f, s.source, `gate-dest-${kind}`);
      let m = d.m;
      if (kind === "removed") {
        const { resultHandoff: _, ...rest } = m;
        m = rest;
      }
      if (kind === "modified")
        m = { ...m, resultHandoff: { ...s.source, text: s.source.text + "changed" } };
      if (kind === "overflow") m = { ...m, text: "x".repeat(120000) };
      if (kind === "unsupported")
        f.setProviders(
          f.providers.map((p) => ({
            ...p,
            models: p.models.map((v) => ({ ...v, inputModalities: ["image"] })),
          })),
        );
      const before = await f.executionCounts();
      const outcome =
        kind === "ordinary-bypass"
          ? await f.dispatch({
              type: "message.dispatch",
              commandId: m.commandId,
              messageId: m.messageId,
              threadId: m.threadId,
              text: m.text,
              attachments: [],
              modelSelection: m.modelSelection,
              routingMode: m.routingMode,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            })
          : await send(f, m);
      expect(outcome._tag).toBe("Failure");
      expect(await f.executionCounts()).toEqual(before);
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);

it.each([
  "changed-text",
  "old-acceptance",
  "failed-output",
  "background",
  "wrong-owner",
  "wrong-scope",
  "missing-id",
  "oversize",
] as const)(
  "rejects %s source without a destination or native work",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const s = await source(f, `source-${kind}`),
        before = await f.executionCounts();
      let selected = s.source;
      if (kind === "changed-text") selected = { ...selected, text: selected.text + "edited" };
      if (kind === "old-acceptance") selected = { ...selected, revision: 2 };
      if (kind === "wrong-scope")
        selected = {
          ...selected,
          reference: { ...selected.reference, projectId: "other-project" },
        };
      if (kind === "missing-id")
        selected = { ...selected, result: { ...selected.result, itemId: "missing" } };
      if (kind === "oversize") selected = { ...selected, text: "x".repeat(16001) };
      if (kind === "failed-output") await f.alterLatestOutput(s.c.threadId, "");
      if (kind === "background") await f.alterBackgroundWork(s.c.threadId);
      if (kind === "wrong-owner") {
        await f.disconnect();
        await f.connectAs("other-owner");
      }
      const base = creation(`bad-${kind}`),
        r = await f.create({
          ...base,
          taskCreationReview: { ...base.taskCreationReview!, resultHandoff: selected },
        });
      expect(r._tag).toBe("Failure");
      expect(await f.executionCounts()).toEqual(before);
    });
  },
  30000,
);

it("failed acceptance-evidence write retains UNKNOWN after successful native dispatch", async () => {
  await withTaskTransportFixture(async (f) => {
    const s = await source(f, "partial-source"),
      d = await destination(f, s.source, "partial-destination");
    f.failJointEvidence("accepted-handoff");
    value(await send(f, d.m));
    await f.settle(d.m.messageId);
    const task = (await f.snapshot()).tasks.find((t) => t.threadId === d.c.threadId)!;
    expect(task.resultReadout).toMatchObject({
      status: "available",
      resultHandoffSelection: s.source,
      resultHandoffDelivery: { status: "unknown" },
    });
    const before = await f.executionCounts();
    await send(f, d.m);
    await f.flush();
    expect(await f.executionCounts()).toEqual(before);
    expect((await f.inspect()).starts).toHaveLength(2);
  });
}, 30000);

it("source A-to-B-to-A event changes cannot revive immutable creation provenance", async () => {
  await withTaskTransportFixture(async (f) => {
    const s = await source(f, "aba-source"),
      d = await destination(f, s.source, "aba-destination");
    value(
      await f.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("source-b"),
        threadId: s.c.threadId,
        title: "Changed source title",
      }),
    );
    value(
      await f.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("source-a"),
        threadId: s.c.threadId,
        title: s.c.title,
      }),
    );
    const fresh = value(await f.projection({ threadId: s.c.threadId }));
    expect(fresh.eventSequence).toBeGreaterThan(s.source.eventSequence);
    const before = await f.executionCounts();
    expect((await send(f, d.m))._tag).toBe("Failure");
    expect(await f.executionCounts()).toEqual(before);
    value(await f.create(d.c));
    expect((await f.snapshot()).tasks).toHaveLength(2);
    expect((await f.inspect()).starts).toHaveLength(1);
  });
}, 30000);
