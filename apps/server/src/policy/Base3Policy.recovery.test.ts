// Disposable synthetic databases live under the OS temp directory.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DEFAULT_DREAM_MEMORY_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  DreamMemoryService,
  layerFromExtractor,
  viewerFromSubject,
} from "../dreamMemory/DreamMemoryService.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";

const extracting = layerFromExtractor({
  extract: (input) =>
    input.eligible
      ? [
          {
            kind: "workflow-convention",
            content: input.turnText,
            confidence: "inferred",
            sensitivity: "internal",
          },
        ]
      : [],
});

let memoryDirSeq = 0;
const memoryDir = (label: string) =>
  NodePath.join(NodeOS.tmpdir(), `base3-${label}-${memoryDirSeq++}`);

const environmentId = EnvironmentId.make("env-recovery");
const projectId = ProjectId.make("project-recovery");
const NOW = "2026-10-05T00:00:00.000Z";
const viewer = viewerFromSubject(environmentId, "alice@example.com", projectId);

it.effect("deleted memory stays deleted after the file-backed database is reopened", () => {
  const dir = memoryDir("memory");
  NodeFS.mkdirSync(dir, { recursive: true });
  return Effect.gen(function* () {
    const dbPath = NodePath.join(dir, "state.sqlite");
    const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const memoryId = yield* Effect.gen(function* () {
      const service = yield* DreamMemoryService;
      const saved = yield* service.save(
        {
          content: "Prefer small diffs.",
          kind: "workflow-convention",
          scopeKind: "project",
          projectId,
        },
        viewer,
        NOW,
        { ...DEFAULT_DREAM_MEMORY_SETTINGS, enabled: true },
      );
      const removed = yield* service.remove({ memoryId: saved.memory.memoryId }, viewer, NOW);
      expect(removed.memory.contentPresent).toBe(false);
      expect(removed.memory.status).toBe("deleted");
      return saved.memory.memoryId;
    }).pipe(Effect.provide(extracting.pipe(Layer.provideMerge(persistence))));

    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const memories = yield* sql<{ readonly status: string; readonly content_present: number }>`
        SELECT status, content_present FROM dream_memories WHERE memory_id = ${memoryId}
      `;
      const tombstones = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM dream_deleted_sources
      `;
      return { memories, tombstones: tombstones[0]?.count ?? 0 };
    }).pipe(Effect.provide(persistence));
    expect(rows.memories[0]?.status).toBe("deleted");
    expect(rows.memories[0]?.content_present).toBe(0);
    expect(rows.tombstones).toBe(1);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer));
});

it.effect("turning memory capture off does not resurrect a deleted row", () => {
  const dir = memoryDir("memory-off");
  NodeFS.mkdirSync(dir, { recursive: true });
  return Effect.gen(function* () {
    const dbPath = NodePath.join(dir, "state.sqlite");
    const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const counts = yield* Effect.gen(function* () {
      const service = yield* DreamMemoryService;
      const saved = yield* service.save(
        {
          content: "Capture this once.",
          kind: "explicit-user-preference",
          scopeKind: "personal",
        },
        viewer,
        NOW,
        { ...DEFAULT_DREAM_MEMORY_SETTINGS, enabled: true },
      );
      yield* service.remove({ memoryId: saved.memory.memoryId }, viewer, NOW);
      yield* service.enqueueEligibleTurn({
        viewer,
        settings: { ...DEFAULT_DREAM_MEMORY_SETTINGS, enabled: false, captureMode: "off" },
        turnSucceeded: true,
        turnText: "Capture this once.",
        nowIso: NOW,
      });
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly status: string; readonly count: number }>`
        SELECT status, COUNT(*) AS count FROM dream_memories GROUP BY status
      `;
    }).pipe(Effect.provide(extracting.pipe(Layer.provideMerge(persistence))));
    expect(counts.find((row) => row.status === "deleted")?.count).toBe(1);
    expect(counts.find((row) => row.status === "active")?.count ?? 0).toBe(0);
    expect(counts.find((row) => row.status === "proposed")?.count ?? 0).toBe(0);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
