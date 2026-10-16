import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import { agentsCreationProvider } from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import {
  makeOpenRouterAdapter,
  OPENROUTER_DRIVER,
} from "../orchestration-v2/Adapters/OpenRouterAdapterV2.ts";

// LOCAL/FIXTURE only. Never reaches OpenRouter or any ambient credential source.
it.live.each(["openrouter/auto", "fixture/text-model"])(
  "OpenRouter governed text-to-persisted-result %s",
  (model) => {
    const requests: Array<Record<string, unknown>> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const data of [
              json({
                id: "gen-fixture",
                model: "fixture/resolved-model",
                choices: [{ delta: { content: "LOCAL/FIXTURE actual " }, finish_reason: null }],
              }),
              json({
                id: "gen-fixture",
                model: "fixture/resolved-model",
                choices: [{ delta: { content: "streamed answer" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 12, completion_tokens: 7, cost: 0.001 },
              }),
              "[DONE]",
            ])
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const instanceId = agentsCreationProvider.instanceId;
    const adapter = makeOpenRouterAdapter({
      instanceId,
      enabled: true,
      models: [model],
      apiKey: Effect.succeed("synthetic-fixture-key"),
      fetch,
    });
    return withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const c = yield* f.createTask(`openrouter-${model.replaceAll("/", "-")}`);
          yield* f.execute(c, `openrouter-message-${model}`, {
            routingMode: "manual",
            modelSelection: { instanceId, model },
          });
          assert.equal(requests.length, 1);
          assert.equal(requests[0]?.model, model);
          const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
          const result = task.resultReadout;
          assert.equal(result?.status, "available");
          if (result?.status !== "available") throw new Error("No result");
          assert.equal(result.runStatus, "completed");
          assert.deepEqual(result.modelIdentity, {
            requested: model,
            resolved: "fixture/resolved-model",
          });
          assert.deepEqual(
            result.content.status === "output" && result.content.preview,
            "LOCAL/FIXTURE actual streamed answer",
          );
          const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
          const turn = projection.providerTurns.find((t) => t.id === result.providerTurnId)!;
          assert.equal(turn.reportedCostUsd, 0.001);
          assert.equal(turn.turnTokenUsage?.inputTokens, 12);
          yield* f.rebuild;
          assert.deepEqual(
            (yield* f.readSnapshot()).tasks.find((t) => t.id === task.id)?.resultReadout,
            result,
          );
          const leases = yield* f.sql`SELECT * FROM base3_capacity_leases`;
          assert.equal(
            leases.filter((lease) => lease.released_at === null).length,
            0,
            json(leases),
          );
          // A second governed message gets persisted context, not an invented native session.
          yield* f.execute(c, `openrouter-followup-${model}`, {
            routingMode: "manual",
            modelSelection: { instanceId, model },
          });
          assert.equal(requests.length, 2);
          assert.include(json(requests[1]?.messages), "LOCAL/FIXTURE actual streamed answer");
        }),
      {
        adapter,
        governedWorker: true,
        provider: {
          ...agentsCreationProvider,
          driver: OPENROUTER_DRIVER,
          models: [
            {
              slug: model,
              name: model,
              isCustom: false,
              capabilities: null,
              inputModalities: ["text"],
            },
          ],
        },
      },
    );
  },
);

it.live.each([401, 429, 200])(
  "OpenRouter governed failure %s persists failure and retains uncertain lease",
  (status) => {
    let requests = 0;
    const instanceId = agentsCreationProvider.instanceId;
    const model = "openrouter/auto";
    const adapter = makeOpenRouterAdapter({
      instanceId,
      enabled: true,
      models: [model],
      apiKey: Effect.succeed("fixture-key"),
      fetch: async () => {
        requests++;
        return new Response("data: malformed\n\n", {
          status,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    return withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const c = yield* f.createTask(`openrouter-failure-${status}`);
          yield* f.execute(c, `openrouter-error-${status}`, {
            routingMode: "manual",
            modelSelection: { instanceId, model },
          });
          assert.equal(requests, 1);
          const result = (yield* f.readSnapshot()).tasks.find(
            (t) => t.threadId === c.threadId,
          )?.resultReadout;
          assert.equal(result?.status === "available" && result.runStatus, "failed");
          assert.equal(result?.status === "available" && result.content.status, "failure");
          const leases =
            yield* f.sql`SELECT released_at,disconnect_unconfirmed FROM base3_capacity_leases WHERE thread_id=${c.threadId}`;
          assert.equal(leases.length, 1);
          assert.equal(leases[0]?.released_at, null);
          assert.equal(leases[0]?.disconnect_unconfirmed, 1);
          const projection = yield* f.orchestrator.getThreadProjection(c.threadId);
          assert.equal(projection.providerTurns[0]?.terminationConfirmed, false);
        }),
      {
        adapter,
        governedWorker: true,
        terminalOnly: true,
        provider: {
          ...agentsCreationProvider,
          driver: OPENROUTER_DRIVER,
          models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
        },
      },
    );
  },
);
