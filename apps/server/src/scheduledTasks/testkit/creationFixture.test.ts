import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createFixture } from "./creationFixture.ts";

const decodeInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);

it.each(["edit", "delete"] as const)(
  "preserves legacy commandId replay after %s, so uncertain clients must recover by reading",
  async (change) => {
    const fixture = createFixture();
    try {
      const input = decodeInput({
        commandId: "creation-recovery-compatibility",
        title: "Original schedule",
        prompt: "Original prompt",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-recovery-compatibility",
        workspaceStrategy: { type: "root" },
        modelSelection: {
          instanceId: "codex",
          model: "fake",
          options: [{ id: "effort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const { task } = await fixture.upsert(input);
      if (change === "edit")
        await fixture.upsert({
          ...input,
          id: task.id,
          requireExisting: true,
          prompt: "Later edit",
        });
      else await fixture.delete({ id: task.id });
      const beforeRead = await fixture.list();
      expect(await fixture.list()).toEqual(beforeRead);
      // Compatibility behavior is intentional. The client recovery path must
      // never use this write to discover whether its initial create committed.
      const replayed = await fixture.upsert(input);
      expect(replayed.task.id).toBe(task.id);
      expect(replayed.task.prompt).toBe("Original prompt");
      expect((await fixture.list()).tasks).toHaveLength(1);
      expect(replayed.task.runCount).toBe(0);
    } finally {
      await fixture.dispose();
    }
  },
);

it("the disposable scheduler dispatches enabled work after fake time advances", async () => {
  const fixture = createFixture();
  try {
    await fixture.upsert(
      decodeInput({
        title: "Scheduler control",
        prompt: "Fake work only",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-control",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "fake" },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
    expect(await fixture.advance(59_999)).toBe(0);
    expect(await fixture.advance(1)).toBe(1);
    expect((await fixture.list()).tasks[0]?.runCount).toBe(1);
  } finally {
    await fixture.dispose();
  }
});
