import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type EnvironmentId,
  type RouterPolicySnapshotV0,
  type TurnOutcomeObservationV0,
  RouterPolicySnapshotV0 as RouterPolicySnapshotSchema,
  TurnOutcomeObservationV0 as TurnOutcomeObservationSchema,
} from "@t3tools/contracts";

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

const ObservationPayloadJson = Schema.fromJsonString(TurnOutcomeObservationSchema);
const PolicyPayloadJson = Schema.fromJsonString(RouterPolicySnapshotSchema);
const encodeObservationPayload = Schema.encodeEffect(ObservationPayloadJson);
const decodeObservationPayload = Schema.decodeUnknownEffect(ObservationPayloadJson);
const encodePolicyPayload = Schema.encodeEffect(PolicyPayloadJson);
const decodePolicyPayload = Schema.decodeUnknownEffect(PolicyPayloadJson);

export class ObservationRepository extends Context.Service<
  ObservationRepository,
  {
    readonly upsert: (
      observation: TurnOutcomeObservationV0,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
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
    readonly deleteByEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, PersistenceSqlError>;
    readonly pruneBefore: (
      environmentId: EnvironmentId,
      cutoffIso: string,
    ) => Effect.Effect<number, PersistenceSqlError>;
    readonly countByEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, PersistenceSqlError>;
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
  }
>()("t3/routerEvaluation/ObservationRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert: ObservationRepository["Service"]["upsert"] = (observation) =>
    encodeObservationPayload(observation).pipe(
      Effect.flatMap(
        (payloadJson) =>
          sql`
            INSERT INTO router_turn_observations (
              observation_id,
              environment_id,
              recorded_at,
              schema_version,
              payload_json
            ) VALUES (
              ${observation.observationId},
              ${observation.environmentId},
              ${observation.recordedAt},
              ${observation.version},
              ${payloadJson}
            )
            ON CONFLICT(observation_id) DO UPDATE SET
              payload_json = excluded.payload_json,
              recorded_at = router_turn_observations.recorded_at
          `,
      ),
      Effect.asVoid,
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("ObservationRepository.upsert:encode", cause)
          : new PersistenceSqlError({
              operation: "ObservationRepository.upsert",
              cause,
            }),
      ),
    );

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
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("ObservationRepository.get:decode", cause)
          : new PersistenceSqlError({ operation: "ObservationRepository.get", cause }),
      ),
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
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("ObservationRepository.list:decode", cause)
          : new PersistenceSqlError({ operation: "ObservationRepository.list", cause }),
      ),
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
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "ObservationRepository.count", cause }),
      ),
    );

  const deleteByEnvironment: ObservationRepository["Service"]["deleteByEnvironment"] = (
    environmentId,
  ) =>
    Effect.gen(function* () {
      const count = yield* countByEnvironment(environmentId);
      yield* sql`DELETE FROM router_turn_observations WHERE environment_id = ${environmentId}`;
      return count;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(PersistenceSqlError)(cause)
          ? cause
          : new PersistenceSqlError({ operation: "ObservationRepository.delete", cause }),
      ),
    );

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
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "ObservationRepository.prune", cause }),
      ),
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
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError(
              "ObservationRepository.upsertPolicy:encode",
              cause,
            )
          : new PersistenceSqlError({ operation: "ObservationRepository.upsertPolicy", cause }),
      ),
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
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError(
              "ObservationRepository.listPolicies:decode",
              cause,
            )
          : new PersistenceSqlError({ operation: "ObservationRepository.listPolicies", cause }),
      ),
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
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("ObservationRepository.getPolicy:decode", cause)
          : new PersistenceSqlError({ operation: "ObservationRepository.getPolicy", cause }),
      ),
    );

  return {
    upsert,
    get,
    listByEnvironment,
    deleteByEnvironment,
    pruneBefore,
    countByEnvironment,
    upsertPolicy,
    listPolicies,
    getPolicy,
  } satisfies ObservationRepository["Service"];
});

export const layer = Layer.effect(ObservationRepository, make);
