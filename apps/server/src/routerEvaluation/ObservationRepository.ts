import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type EnvironmentId,
  type MessageId,
  type ObservationId,
  type ReworkSignalV0,
  type RouterObservationEventV0,
  type RouterPolicySnapshotV0,
  type ThreadId,
  type TurnOutcomeObservationV0,
  ROUTER_OBSERVATION_EVENT_VERSION,
  RouterObservationEventV0 as RouterObservationEventSchema,
  RouterPolicySnapshotV0 as RouterPolicySnapshotSchema,
  TurnOutcomeObservationV0 as TurnOutcomeObservationSchema,
  ObservationEventId,
} from "@t3tools/contracts";
import { mergeTerminalWrite, type TerminalWriteResult } from "@t3tools/shared/turnOutcome";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

const ObservationRow = Schema.Struct({
  observationId: Schema.String,
  environmentId: Schema.String,
  recordedAt: Schema.String,
  schemaVersion: Schema.String,
  payloadJson: Schema.String,
});

const PolicyRow = Schema.Struct({
  policyId: Schema.String,
  environmentId: Schema.String,
  state: Schema.String,
  createdAt: Schema.String,
  payloadJson: Schema.String,
});

const EventRow = Schema.Struct({
  payloadJson: Schema.String,
});

const ObservationPayloadJson = Schema.fromJsonString(TurnOutcomeObservationSchema);
const PolicyPayloadJson = Schema.fromJsonString(RouterPolicySnapshotSchema);
const EventPayloadJson = Schema.fromJsonString(RouterObservationEventSchema);
const encodeObservationPayload = Schema.encodeEffect(ObservationPayloadJson);
const decodeObservationPayload = Schema.decodeUnknownEffect(ObservationPayloadJson);
const encodePolicyPayload = Schema.encodeEffect(PolicyPayloadJson);
const decodePolicyPayload = Schema.decodeUnknownEffect(PolicyPayloadJson);
const encodeEventPayload = Schema.encodeEffect(EventPayloadJson);
const decodeEventPayload = Schema.decodeUnknownEffect(EventPayloadJson);

export type RecordTerminalContext = {
  readonly threadId?: ThreadId;
  readonly messageId?: MessageId;
};

export class ObservationRepository extends Context.Service<
  ObservationRepository,
  {
    readonly upsert: (
      observation: TurnOutcomeObservationV0,
      context?: RecordTerminalContext,
    ) => Effect.Effect<TerminalWriteResult, PersistenceSqlError | PersistenceDecodeError>;
    readonly get: (
      observationId: string,
    ) => Effect.Effect<
      Option.Option<TurnOutcomeObservationV0>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly listByEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      ReadonlyArray<TurnOutcomeObservationV0>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly latestForThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      exceptObservationId?: ObservationId,
    ) => Effect.Effect<
      Option.Option<TurnOutcomeObservationV0>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly replaceEvidence: (
      observation: TurnOutcomeObservationV0,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
    readonly deleteByEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
    readonly pruneBefore: (
      environmentId: EnvironmentId,
      cutoffIso: string,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
    readonly countByEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
    readonly upsertPolicy: (
      policy: RouterPolicySnapshotV0,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
    readonly listPolicies: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      ReadonlyArray<RouterPolicySnapshotV0>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly getPolicy: (
      policyId: string,
    ) => Effect.Effect<
      Option.Option<RouterPolicySnapshotV0>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly appendEvent: (
      event: RouterObservationEventV0,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
    readonly listEvents: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      ReadonlyArray<RouterObservationEventV0>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly nextEventSequence: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, PersistenceSqlError | PersistenceDecodeError>;
  }
>()("t3/routerEvaluation/ObservationRepository") {}

const toRepoError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:codec`, cause)
      : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: ObservationRepository["Service"]["get"] = (observationId) =>
    sql<typeof ObservationRow.Type>`
      SELECT
        observation_id AS "observationId",
        environment_id AS "environmentId",
        recorded_at AS "recordedAt",
        schema_version AS "schemaVersion",
        payload_json AS "payloadJson"
      FROM router_turn_observations
      WHERE observation_id = ${observationId}
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeObservationPayload(row.payloadJson).pipe(Effect.map(Option.some));
      }),
      Effect.mapError(toRepoError("ObservationRepository.get")),
    );

  const writePayload = (
    observation: TurnOutcomeObservationV0,
    context: RecordTerminalContext | undefined,
    payloadJson: string,
  ) =>
    sql`
      INSERT INTO router_turn_observations (
        observation_id,
        environment_id,
        recorded_at,
        schema_version,
        payload_json,
        thread_id,
        message_id
      ) VALUES (
        ${observation.observationId},
        ${observation.environmentId},
        ${observation.recordedAt},
        ${observation.version},
        ${payloadJson},
        ${context?.threadId ?? null},
        ${context?.messageId ?? null}
      )
      ON CONFLICT(observation_id) DO UPDATE SET
        payload_json = CASE
          WHEN json_extract(router_turn_observations.payload_json, '$.terminalCategory') IN (
            'cancelled',
            'timeout',
            'provider_failure',
            'infrastructure_failure'
          )
          AND json_extract(excluded.payload_json, '$.terminalCategory') = 'success'
          THEN router_turn_observations.payload_json
          ELSE excluded.payload_json
        END,
        thread_id = COALESCE(router_turn_observations.thread_id, excluded.thread_id),
        message_id = COALESCE(router_turn_observations.message_id, excluded.message_id)
    `;

  const nextEventSequence: ObservationRepository["Service"]["nextEventSequence"] = (
    environmentId,
  ) =>
    sql<{ readonly sequence: number | null }>`
      SELECT MAX(sequence) AS "sequence"
      FROM router_observation_events
      WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.sequence ?? 0) + 1),
      Effect.mapError(toRepoError("ObservationRepository.nextEventSequence")),
    );

  const appendEvent: ObservationRepository["Service"]["appendEvent"] = (event) =>
    encodeEventPayload(event).pipe(
      Effect.flatMap(
        (payloadJson) =>
          sql`
            INSERT INTO router_observation_events (
              event_id,
              environment_id,
              observation_id,
              event_type,
              recorded_at,
              idempotency_key,
              sequence,
              schema_version,
              payload_json
            ) VALUES (
              ${event.eventId},
              ${event.environmentId},
              ${event.observationId ?? null},
              ${event.eventType},
              ${event.recordedAt},
              ${event.idempotencyKey},
              ${event.sequence},
              ${event.schemaVersion},
              ${payloadJson}
            )
            ON CONFLICT(environment_id, idempotency_key) DO NOTHING
          `,
      ),
      Effect.asVoid,
      Effect.mapError(toRepoError("ObservationRepository.appendEvent")),
    );

  const makeEvent = (input: {
    readonly environmentId: EnvironmentId;
    readonly observationId?: ObservationId;
    readonly eventType: RouterObservationEventV0["eventType"];
    readonly recordedAt: string;
    readonly idempotencyKey: string;
    readonly sequence: number;
    readonly actor?: string;
    readonly terminalCategory?: TurnOutcomeObservationV0["terminalCategory"];
    readonly detail?: string;
  }): RouterObservationEventV0 => ({
    version: ROUTER_OBSERVATION_EVENT_VERSION,
    eventId: ObservationEventId.make(input.idempotencyKey.slice(0, 128)),
    environmentId: input.environmentId,
    ...(input.observationId !== undefined ? { observationId: input.observationId } : {}),
    eventType: input.eventType,
    recordedAt: input.recordedAt,
    idempotencyKey: input.idempotencyKey,
    sequence: input.sequence,
    schemaVersion: ROUTER_OBSERVATION_EVENT_VERSION,
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    ...(input.terminalCategory !== undefined ? { terminalCategory: input.terminalCategory } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });

  const upsert: ObservationRepository["Service"]["upsert"] = (observation, context) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* get(observation.observationId);
          const merged = mergeTerminalWrite(Option.getOrUndefined(existing), observation);
          const payloadJson = yield* encodeObservationPayload(merged.observation);
          yield* writePayload(merged.observation, context, payloadJson);
          const sequence = yield* nextEventSequence(observation.environmentId);
          const eventType =
            merged.kind === "rejected"
              ? ("conflict_rejected" as const)
              : merged.kind === "enriched"
                ? ("usage_enriched" as const)
                : ("terminal_recorded" as const);
          yield* appendEvent(
            makeEvent({
              environmentId: observation.environmentId,
              observationId: observation.observationId,
              eventType,
              recordedAt: observation.recordedAt,
              idempotencyKey: `${eventType}:${observation.observationId}:${merged.observation.terminalCategory}:${merged.kind}`,
              sequence,
              terminalCategory: merged.observation.terminalCategory,
              ...(merged.reason !== undefined ? { detail: merged.reason } : {}),
            }),
          );
          return merged;
        }),
      )
      .pipe(Effect.mapError(toRepoError("ObservationRepository.upsert")));

  const replaceEvidence: ObservationRepository["Service"]["replaceEvidence"] = (observation) =>
    encodeObservationPayload(observation).pipe(
      Effect.flatMap(
        (payloadJson) =>
          sql`
            UPDATE router_turn_observations
            SET payload_json = CASE
              WHEN json_extract(payload_json, '$.terminalCategory') = ${observation.terminalCategory}
              THEN ${payloadJson}
              ELSE payload_json
            END
            WHERE observation_id = ${observation.observationId}
          `,
      ),
      Effect.asVoid,
      Effect.mapError(toRepoError("ObservationRepository.replaceEvidence")),
    );

  const listByEnvironment: ObservationRepository["Service"]["listByEnvironment"] = (
    environmentId,
  ) =>
    sql<typeof ObservationRow.Type>`
      SELECT
        observation_id AS "observationId",
        environment_id AS "environmentId",
        recorded_at AS "recordedAt",
        schema_version AS "schemaVersion",
        payload_json AS "payloadJson"
      FROM router_turn_observations
      WHERE environment_id = ${environmentId}
      ORDER BY recorded_at ASC, observation_id ASC
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeObservationPayload(row.payloadJson)),
      ),
      Effect.mapError(toRepoError("ObservationRepository.list")),
    );

  const latestForThread: ObservationRepository["Service"]["latestForThread"] = (
    environmentId,
    threadId,
    exceptObservationId,
  ) =>
    sql<typeof ObservationRow.Type>`
      SELECT
        observation_id AS "observationId",
        environment_id AS "environmentId",
        recorded_at AS "recordedAt",
        schema_version AS "schemaVersion",
        payload_json AS "payloadJson"
      FROM router_turn_observations
      WHERE environment_id = ${environmentId}
        AND thread_id = ${threadId}
        AND observation_id != ${exceptObservationId ?? ""}
      ORDER BY recorded_at DESC, observation_id DESC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeObservationPayload(row.payloadJson).pipe(Effect.map(Option.some));
      }),
      Effect.mapError(toRepoError("ObservationRepository.latestForThread")),
    );

  const countByEnvironment: ObservationRepository["Service"]["countByEnvironment"] = (
    environmentId,
  ) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count"
      FROM router_turn_observations
      WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      Effect.mapError(toRepoError("ObservationRepository.count")),
    );

  const deleteByEnvironment: ObservationRepository["Service"]["deleteByEnvironment"] = (
    environmentId,
  ) =>
    Effect.gen(function* () {
      const count = yield* countByEnvironment(environmentId);
      yield* sql`DELETE FROM router_turn_observations WHERE environment_id = ${environmentId}`;
      return count;
    }).pipe(Effect.mapError(toRepoError("ObservationRepository.delete")));

  const pruneBefore: ObservationRepository["Service"]["pruneBefore"] = (environmentId, cutoffIso) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count"
      FROM router_turn_observations
      WHERE environment_id = ${environmentId} AND recorded_at < ${cutoffIso}
    `.pipe(
      Effect.flatMap((rows) => {
        const count = Number(rows[0]?.count ?? 0);
        return sql`
          DELETE FROM router_turn_observations
          WHERE environment_id = ${environmentId} AND recorded_at < ${cutoffIso}
        `.pipe(Effect.as(count));
      }),
      Effect.mapError(toRepoError("ObservationRepository.prune")),
    );

  const upsertPolicy: ObservationRepository["Service"]["upsertPolicy"] = (policy) =>
    encodePolicyPayload(policy).pipe(
      Effect.flatMap(
        (payloadJson) =>
          sql`
            INSERT INTO router_policies (
              policy_id,
              environment_id,
              state,
              created_at,
              payload_json
            ) VALUES (
              ${policy.policyId},
              ${policy.environmentId},
              ${policy.state},
              ${policy.createdAt},
              ${payloadJson}
            )
            ON CONFLICT(policy_id) DO UPDATE SET
              state = excluded.state,
              payload_json = excluded.payload_json
          `,
      ),
      Effect.asVoid,
      Effect.mapError(toRepoError("ObservationRepository.upsertPolicy")),
    );

  const listPolicies: ObservationRepository["Service"]["listPolicies"] = (environmentId) =>
    sql<typeof PolicyRow.Type>`
      SELECT
        policy_id AS "policyId",
        environment_id AS "environmentId",
        state AS "state",
        created_at AS "createdAt",
        payload_json AS "payloadJson"
      FROM router_policies
      WHERE environment_id = ${environmentId}
      ORDER BY created_at ASC, policy_id ASC
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodePolicyPayload(row.payloadJson))),
      Effect.mapError(toRepoError("ObservationRepository.listPolicies")),
    );

  const getPolicy: ObservationRepository["Service"]["getPolicy"] = (policyId) =>
    sql<typeof PolicyRow.Type>`
      SELECT
        policy_id AS "policyId",
        environment_id AS "environmentId",
        state AS "state",
        created_at AS "createdAt",
        payload_json AS "payloadJson"
      FROM router_policies
      WHERE policy_id = ${policyId}
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodePolicyPayload(row.payloadJson).pipe(Effect.map(Option.some));
      }),
      Effect.mapError(toRepoError("ObservationRepository.getPolicy")),
    );

  const listEvents: ObservationRepository["Service"]["listEvents"] = (environmentId) =>
    sql<typeof EventRow.Type>`
      SELECT payload_json AS "payloadJson"
      FROM router_observation_events
      WHERE environment_id = ${environmentId}
      ORDER BY sequence ASC, event_id ASC
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeEventPayload(row.payloadJson))),
      Effect.mapError(toRepoError("ObservationRepository.listEvents")),
    );

  return {
    upsert,
    get,
    listByEnvironment,
    latestForThread,
    replaceEvidence,
    deleteByEnvironment,
    pruneBefore,
    countByEnvironment,
    upsertPolicy,
    listPolicies,
    getPolicy,
    appendEvent,
    listEvents,
    nextEventSequence,
  } satisfies ObservationRepository["Service"];
});

export const layer = Layer.effect(ObservationRepository, make);

export { type ReworkSignalV0 };
