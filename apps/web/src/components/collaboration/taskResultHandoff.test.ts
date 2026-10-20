import { digestCanonical } from "@t3tools/shared/actionCanonical";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { withHandoffFactsFixture } from "./testkit/taskResultHandoffFactsFixture";
import {
  acceptedResultFacts,
  resultHandoffReference,
  verifyResultHandoff,
  resultHandoffInput,
  resultHandoffText,
} from "@t3tools/shared/taskResultHandoff";
import { revisionRequestFacts } from "@t3tools/shared/taskRevisionRequest";

it("hands off the complete accepted output while preserving the unaccepted continuation gate", async () => {
  await withHandoffFactsFixture(async (f) => {
    const env = EnvironmentId.make("environment-a");
    const before = await f.readOwnedReviewAsync();
    if (before.status !== "available") throw new Error("review missing");
    expect(acceptedResultFacts(f.snapshot.tasks[0]!, env, before, f.projection)).toBeNull();
    await f.acceptAsync(before.reference);
    const fresh = await f.freshFactsAsync(),
      review = await f.readOwnedReviewAsync();
    const facts = acceptedResultFacts(fresh.snapshot.tasks[0]!, env, review, fresh.projection);
    expect(facts).not.toBeNull();
    if (!facts) throw new Error("accepted facts missing");
    for (const mode of [
      "old-acceptance",
      "missing-attempt",
      "streaming",
      "duplicate-item",
      "background",
      "failed-turn",
    ] as const) {
      let task = facts.task,
        projection = facts.projection;
      if (mode === "old-acceptance" && task.contractReadout?.status === "available")
        task = { ...task, contractReadout: { ...task.contractReadout, acceptedRevision: 0 } };
      if (mode === "missing-attempt") projection = { ...projection, attempts: [] };
      if (mode === "duplicate-item")
        projection = {
          ...projection,
          turnItems: [...projection.turnItems, projection.turnItems[0]!],
        };
      if (mode === "streaming")
        projection = {
          ...projection,
          turnItems: projection.turnItems.map((i) =>
            i.type === "assistant_message" ? { ...i, streaming: true } : i,
          ),
        };
      if (mode === "background")
        projection = {
          ...projection,
          providerThreads: projection.providerThreads.map((t) => ({ ...t, status: "active" })),
        };
      if (mode === "failed-turn")
        projection = {
          ...projection,
          providerTurns: projection.providerTurns.map((t) => ({ ...t, status: "failed" })),
        };
      expect(acceptedResultFacts(task, env, facts.review, projection), mode).toBeNull();
    }
    const newerContract = { ...facts.review.contract, revision: 2 };
    const newerTask = {
      ...facts.task,
      contractReadout: {
        status: "available" as const,
        contract: newerContract,
        phase: "active" as const,
        acceptedRevision: 2,
      },
    };
    expect(
      acceptedResultFacts(
        newerTask,
        env,
        { ...facts.review, contract: newerContract, acceptedRevision: 2 },
        {
          ...facts.projection,
          thread: {
            ...facts.projection.thread,
            taskContract: newerContract,
            taskAcceptedRevision: 2,
          },
        },
      ),
    ).toBeNull();
    expect(
      acceptedResultFacts(facts.task, env, facts.review, {
        ...facts.projection,
        messages: facts.projection.messages.map((m) => {
          const { taskFirstLaunch: _, ...plain } = m;
          return plain;
        }),
      }),
    ).toBeNull();
    const spacedText = " ".repeat(2200) + "complete output beyond preview";
    const spacedTask = {
      ...facts.task,
      resultReadout: {
        ...facts.result,
        content: { ...facts.result.content, preview: spacedText.slice(0, 2048), truncated: true },
      },
    };
    const spacedFacts = acceptedResultFacts(spacedTask, env, facts.review, {
      ...facts.projection,
      turnItems: facts.projection.turnItems.map((item) =>
        item.type === "assistant_message" ? { ...item, text: spacedText } : item,
      ),
    });
    expect(spacedFacts).not.toBeNull();
    if (spacedFacts) expect(resultHandoffReference(spacedFacts).text).toBe(spacedText);
    const source = resultHandoffReference(facts);
    const fullText = "é".repeat(16000),
      bounded = {
        ...source,
        text: fullText,
        result: { ...source.result, outputSha256: digestCanonical(fullText) },
      };
    expect(verifyResultHandoff(bounded)).toBe(bounded);
    expect(() =>
      verifyResultHandoff({
        ...bounded,
        text: fullText + "x",
        result: { ...bounded.result, outputSha256: digestCanonical(fullText + "x") },
      }),
    ).toThrow();
    const instructions = "x".repeat(120000 - resultHandoffText(bounded).length);
    expect(resultHandoffInput(instructions, bounded)).toHaveLength(120000);
    expect(() => resultHandoffInput(instructions + "x", bounded)).toThrow();
    expect(source.text.length).toBeGreaterThan(2048);
    expect(source.text).toBe("Attributed parser output. " + "x".repeat(2200));
    expect(
      revisionRequestFacts(fresh.snapshot.tasks[0]!, env, review, fresh.projection),
    ).toBeNull();
    expect(await f.countsAsync()).toMatchObject({ runs: 1 });
  });
});
