import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

/** Seed V2 once. Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const hasBase3PolicyTables = yield* Effect.tryPromise(async () => {
      const probe = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        const rows = probe
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN (
                 'projection_dispatcher_task_routes',
                 'action_gate_approvals',
                 'dream_memories',
                 'projection_task_handoffs'
               )`,
          )
          .all() as unknown as ReadonlyArray<{ readonly name: string }>;
        return rows.length > 0;
      } finally {
        probe.close();
      }
    });
    if (hasBase3PolicyTables) {
      yield* Effect.logWarning(
        "Skipped copying a Base3Router database into V2. Import policy rows with importBase3Policy instead of the upstream id-only copy.",
      );
      return;
    }
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});
