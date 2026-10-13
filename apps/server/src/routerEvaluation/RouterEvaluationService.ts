import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type EnvironmentId,
  type LocalTaskProfile,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  type EnvironmentRouterPolicyCommand,
  type ObservationId,
  type ReworkSignalV0,
  type RouterActivatePolicyRequest,
  type RouterDeleteObservationsRequest,
  type RouterExportObservationsResult,
  type RouterInsightsSnapshotV0,
  type RouterListPoliciesResult,
  type RouterPolicyMutationResult,
  type RouterPolicySnapshotV0,
  type RouterRollbackPolicyRequest,
  type RouterShadowPolicyRequest,
  type RouterSubmitFeedbackRequest,
  type RouterSubmitFeedbackResult,
  type ThreadId,
  type TurnOutcomeObservationV0,
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  HYBRID_MIN_SAMPLE_RATE,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_SHRINKAGE_K,
  MODEL_ROUTER_POLICY_VERSION,
  ROUTER_OBSERVATION_EVENT_VERSION,
  ROUTER_POLICY_SNAPSHOT_VERSION,
  RouterEvaluationError,
  RouterPolicyId,
  ObservationEventId,
} from "@t3tools/contracts";
import {
  buildEvaluationDataset,
  calculateEvaluationMetrics,
  evidenceFromObservations,
  evidenceForLocalTask,
} from "@t3tools/shared/routerEvaluation";
import type { LocalModelEvidence } from "@t3tools/shared/hybridRouter";
import {
  activatePolicy,
  baselinePolicyId,
  isBaselinePolicyVersion,
  rollbackPolicy,
  shadowPolicy,
} from "@t3tools/shared/routerPolicy";

import {
  ObservationRepository,
  layer as observationRepositoryLayer,
  type RecordTerminalContext,
} from "./ObservationRepository.ts";

export class RouterEvaluationService extends Context.Service<
  RouterEvaluationService,
  {
    readonly control: (
      environmentId: EnvironmentId,
      input: EnvironmentRouterPolicyCommand,
      now: string,
      actor: string,
    ) => Effect.Effect<RouterPolicyStatus, RouterEvaluationError>;
    readonly status: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<RouterPolicyStatus, RouterEvaluationError>;
    readonly routingSnapshot: (
      environmentId: EnvironmentId,
      localTaskProfile?: LocalTaskProfile,
    ) => Effect.Effect<RouterPolicyRuntimeSnapshot, RouterEvaluationError>;
    readonly insights: (
      environmentId: EnvironmentId,
      settings: {
        readonly measurementEnabled: boolean;
        readonly retentionDays: number;
        readonly challengerShadowEnabled: boolean;
      },
    ) => Effect.Effect<RouterInsightsSnapshotV0, RouterEvaluationError>;
    readonly exportObservations: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<RouterExportObservationsResult, RouterEvaluationError>;
    readonly deleteObservations: (
      environmentId: EnvironmentId,
      input: RouterDeleteObservationsRequest,
      actor?: string,
    ) => Effect.Effect<{ readonly deleted: number }, RouterEvaluationError>;
    readonly submitFeedback: (
      environmentId: EnvironmentId,
      input: RouterSubmitFeedbackRequest,
      now: string,
      actor?: string,
    ) => Effect.Effect<RouterSubmitFeedbackResult, RouterEvaluationError>;
    readonly recordReworkProxy: (
      environmentId: EnvironmentId,
      observationId: ObservationId,
      proxy: ReworkSignalV0,
    ) => Effect.Effect<void, RouterEvaluationError>;
    readonly listPolicies: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<RouterListPoliciesResult, RouterEvaluationError>;
    readonly inspectPolicy: (
      environmentId: EnvironmentId,
      policyId: string,
    ) => Effect.Effect<RouterPolicySnapshotV0, RouterEvaluationError>;
    readonly activate: (
      environmentId: EnvironmentId,
      input: RouterActivatePolicyRequest,
      authorized: boolean,
      now: string,
      actor?: string,
      expectedRevision?: number,
    ) => Effect.Effect<RouterPolicyMutationResult, RouterEvaluationError>;
    readonly shadow: (
      environmentId: EnvironmentId,
      input: RouterShadowPolicyRequest,
      authorized: boolean,
      now: string,
      actor?: string,
      expectedRevision?: number,
    ) => Effect.Effect<RouterPolicyMutationResult, RouterEvaluationError>;
    readonly rollback: (
      environmentId: EnvironmentId,
      input: RouterRollbackPolicyRequest,
      authorized: boolean,
      now: string,
      actor?: string,
      expectedRevision?: number,
    ) => Effect.Effect<RouterPolicyMutationResult, RouterEvaluationError>;
    readonly evidenceMap: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyMap<string, LocalModelEvidence>, RouterEvaluationError>;
    readonly recordObservation: (
      observation: TurnOutcomeObservationV0,
      context?: RecordTerminalContext,
    ) => Effect.Effect<void, RouterEvaluationError>;
    readonly latestObservationForThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      exceptObservationId?: ObservationId,
    ) => Effect.Effect<Option.Option<TurnOutcomeObservationV0>, RouterEvaluationError>;
    readonly observationCount: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, RouterEvaluationError>;
    readonly activePolicyVersion: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<string, RouterEvaluationError>;
  }
>()("t3/routerEvaluation/RouterEvaluationService") {}

const isEvaluationError = Schema.is(RouterEvaluationError);
const toEvalError = (cause: unknown): RouterEvaluationError =>
  isEvaluationError(cause)
    ? cause
    : new RouterEvaluationError({
        reason: "malformed_policy",
        detail: cause instanceof Error ? cause.message : "Observation store failed.",
      });

const scopedPolicyId = (environmentId: EnvironmentId, version: string) =>
  RouterPolicyId.make(
    `${isBaselinePolicyVersion(version) ? baselinePolicyId : version === HYBRID_TASK_ROUTER_POLICY_VERSION ? "policy-hybrid-router-task-v2" : "policy-hybrid-router-v1"}-${NodeCrypto.createHash("sha256").update(`${environmentId}:${version}`).digest("hex")}`,
  );

type RouterPolicyStatus = {
  readonly environmentId: EnvironmentId;
  readonly policies: ReadonlyArray<RouterPolicySnapshotV0>;
  readonly active: RouterPolicySnapshotV0;
  readonly revision: number;
};
type RouterPolicyRuntimeSnapshot = RouterPolicyStatus & {
  readonly challengerPolicy?: RouterPolicySnapshotV0;
  readonly taskEvidenceByTarget: ReadonlyMap<string, LocalModelEvidence>;
  readonly challengerEnabled: boolean;
  readonly evidenceByTarget: ReadonlyMap<string, LocalModelEvidence>;
};

const baselineSnapshot = (environmentId: EnvironmentId, now: string): RouterPolicySnapshotV0 => ({
  version: ROUTER_POLICY_SNAPSHOT_VERSION,
  policyId: scopedPolicyId(environmentId, MODEL_ROUTER_POLICY_VERSION),
  policyVersion: MODEL_ROUTER_POLICY_VERSION,
  state: "active",
  environmentId,
  createdAt: now,
  weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
  shrinkageK: HYBRID_SHRINKAGE_K,
  minSampleRate: HYBRID_MIN_SAMPLE_RATE,
  recencyDecayImplemented: false,
});

const hybridCandidateSnapshot = (
  environmentId: EnvironmentId,
  now: string,
  provenance: { readonly sourceDatasetHash: string; readonly evaluationRecordId: string },
  policyVersion: string = HYBRID_ROUTER_POLICY_VERSION,
): RouterPolicySnapshotV0 => ({
  version: ROUTER_POLICY_SNAPSHOT_VERSION,
  policyId: scopedPolicyId(environmentId, policyVersion),
  policyVersion,
  state: "candidate",
  environmentId,
  createdAt: now,
  sourceDatasetHash: provenance.sourceDatasetHash,
  evaluationRecordId: provenance.evaluationRecordId,
  weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
  shrinkageK: HYBRID_SHRINKAGE_K,
  minSampleRate: HYBRID_MIN_SAMPLE_RATE,
  recencyDecayImplemented: false,
});

const make = Effect.gen(function* () {
  const store = yield* ObservationRepository;

  const datasetProvenance = (environmentId: EnvironmentId) =>
    store.listByEnvironment(environmentId).pipe(
      Effect.map((records) => {
        const dataset = buildEvaluationDataset({ records, synthetic: false });
        return {
          sourceDatasetHash: dataset.manifest.datasetHash,
          evaluationRecordId: `eval-${dataset.manifest.datasetHash}`,
        };
      }),
    );

  const appendAudit = (input: {
    readonly environmentId: EnvironmentId;
    readonly eventType:
      | "policy_activated"
      | "policy_shadowed"
      | "policy_rolled_back"
      | "observations_deleted"
      | "retention_pruned"
      | "explicit_feedback"
      | "rework_proxy";
    readonly recordedAt: string;
    readonly idempotencyKey: string;
    readonly actor?: string;
    readonly observationId?: ObservationId;
    readonly detail?: string;
  }) =>
    store.nextEventSequence(input.environmentId).pipe(
      Effect.flatMap((sequence) =>
        store.appendEvent({
          version: ROUTER_OBSERVATION_EVENT_VERSION,
          eventId: ObservationEventId.make(input.idempotencyKey.slice(0, 128)),
          environmentId: input.environmentId,
          ...(input.observationId !== undefined ? { observationId: input.observationId } : {}),
          eventType: input.eventType,
          recordedAt: input.recordedAt,
          idempotencyKey: input.idempotencyKey,
          sequence,
          schemaVersion: ROUTER_OBSERVATION_EVENT_VERSION,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
        }),
      ),
    );

  const ensureDefaults = (environmentId: EnvironmentId, now: string) =>
    store.transaction(
      Effect.gen(function* () {
        const policies = yield* store.listPolicies(environmentId);
        if (policies.filter((policy) => policy.state === "active").length > 1)
          return yield* new RouterEvaluationError({
            reason: "malformed_policy",
            detail: "Multiple active policies; policy repair is required.",
          });
        const provenance = yield* datasetProvenance(environmentId);
        if (!policies.some((policy) => isBaselinePolicyVersion(policy.policyVersion))) {
          yield* store.upsertPolicy({
            ...baselineSnapshot(environmentId, now),
            state: policies.some((policy) => policy.state === "active") ? "retired" : "active",
          });
          yield* appendAudit({
            environmentId,
            eventType: "policy_activated",
            recordedAt: now,
            idempotencyKey: `initialize:${scopedPolicyId(environmentId, MODEL_ROUTER_POLICY_VERSION)}`,
            detail: "Initialize baseline V0 only; no Hybrid activation.",
          });
        }
        if (!policies.some((policy) => policy.policyVersion === HYBRID_TASK_ROUTER_POLICY_VERSION))
          yield* store.upsertPolicy(
            hybridCandidateSnapshot(
              environmentId,
              now,
              provenance,
              HYBRID_TASK_ROUTER_POLICY_VERSION,
            ),
          );
        const candidate = policies.find(
          (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
        );
        if (candidate === undefined) {
          yield* store.upsertPolicy(hybridCandidateSnapshot(environmentId, now, provenance));
        }
      }),
    );

  const policyRevision = (environmentId: EnvironmentId) =>
    store
      .listEvents(environmentId)
      .pipe(
        Effect.map((events) =>
          events
            .filter((event) => event.eventType.startsWith("policy_"))
            .reduce((revision, event) => Math.max(revision, event.sequence), 0),
        ),
      );
  const validateMutation = (
    environmentId: EnvironmentId,
    authorized: boolean,
    confirmed: boolean,
    expectedRevision?: number,
  ) =>
    Effect.gen(function* () {
      if (!authorized)
        return yield* new RouterEvaluationError({
          reason: "unauthorized_activation",
          detail: "Operator permission is required.",
        });
      if (!confirmed)
        return yield* new RouterEvaluationError({
          reason: "confirmation_required",
          detail: "Explicit confirmation is required.",
        });
      if (
        expectedRevision !== undefined &&
        expectedRevision !== (yield* policyRevision(environmentId))
      )
        return yield* new RouterEvaluationError({
          reason: "illegal_transition",
          detail: "Policy status changed; refresh before confirming.",
        });
    });
  const readStatus = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      yield* ensureDefaults(environmentId, "1970-01-01T00:00:00.000Z");
      const policies = yield* store.listPolicies(environmentId);
      const active = policies.filter((policy) => policy.state === "active");
      if (active.length !== 1)
        return yield* new RouterEvaluationError({
          reason: "malformed_policy",
          detail: "Exactly one active policy is required.",
        });
      return {
        environmentId,
        policies,
        active: active[0]!,
        revision: yield* policyRevision(environmentId),
      };
    });
  const status: RouterEvaluationService["Service"]["status"] = (environmentId) =>
    store.transaction(readStatus(environmentId)).pipe(Effect.mapError(toEvalError));
  const routingSnapshot: RouterEvaluationService["Service"]["routingSnapshot"] = (
    environmentId,
    localTaskProfile,
  ) =>
    store
      .transaction(
        Effect.gen(function* () {
          const snapshot = yield* readStatus(environmentId);
          const shadows = snapshot.policies.filter((policy) => policy.state === "shadow");
          if (shadows.length > 1)
            return yield* new RouterEvaluationError({
              reason: "malformed_policy",
              detail: "Multiple shadow policies; repair is required.",
            });
          const challengerPolicy = shadows[0];
          const records = yield* store.listByEnvironment(environmentId);
          return {
            ...(challengerPolicy === undefined ? {} : { challengerPolicy }),
            ...snapshot,
            challengerEnabled: snapshot.policies.some((policy) => policy.state === "shadow"),
            evidenceByTarget: evidenceFromObservations(records),
            taskEvidenceByTarget: evidenceForLocalTask({
              records,
              environmentId,
              ...(localTaskProfile === undefined ? {} : { profile: localTaskProfile }),
            }),
          };
        }),
      )
      .pipe(Effect.mapError(toEvalError));

  const insights: RouterEvaluationService["Service"]["insights"] = (environmentId, settings) =>
    Effect.gen(function* () {
      yield* ensureDefaults(environmentId, "1970-01-01T00:00:00.000Z");
      const now = yield* DateTime.now;
      const cutoff = DateTime.formatIso(
        DateTime.subtract(now, { days: Math.max(1, settings.retentionDays) }),
      );
      const pruned = yield* store.pruneBefore(environmentId, cutoff);
      if (pruned > 0) {
        yield* appendAudit({
          environmentId,
          eventType: "retention_pruned",
          recordedAt: DateTime.formatIso(now),
          idempotencyKey: `retention:${cutoff}:${pruned}`,
          detail: `pruned ${pruned}`,
        });
      }
      const records = yield* store.listByEnvironment(environmentId);
      const policies = yield* store.listPolicies(environmentId);
      const active =
        policies.find((policy) => policy.state === "active") ??
        baselineSnapshot(environmentId, "1970-01-01T00:00:00.000Z");
      const candidate = policies.find(
        (policy) =>
          policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION &&
          (policy.state === "candidate" || policy.state === "shadow"),
      );
      const metrics = calculateEvaluationMetrics(records);
      const coverage = metrics[0] ?? {
        id: "coverage",
        numerator: 0,
        denominator: 0,
        sampleCount: 0,
        status: "unknown" as const,
        provenance: "unknown" as const,
        unit: "rate" as const,
      };
      const latest = records.at(-1);
      return {
        observationCount: records.length,
        coverage: {
          ...coverage,
          id: "coverage",
          numerator: records.length,
          denominator: records.length,
          sampleCount: records.length,
          status:
            records.length === 0
              ? "unknown"
              : records.length >= HYBRID_MIN_SAMPLE_RATE
                ? "reliable"
                : "insufficient",
        },
        activePolicyVersion: active.policyVersion,
        ...(candidate !== undefined ? { candidatePolicyVersion: candidate.policyVersion } : {}),
        ...(candidate !== undefined ? { candidatePolicyId: candidate.policyId } : {}),
        ...(candidate !== undefined ? { candidatePolicyState: candidate.state } : {}),
        challengerEnabled: settings.challengerShadowEnabled,
        measurementEnabled: settings.measurementEnabled,
        retentionDays: settings.retentionDays,
        freshness: records.length === 0 ? "empty" : "fresh",
        metrics,
        mixedProvenanceWarning: records.some((record) => record.cost.mixedProvenance),
        insufficientData: records.length < HYBRID_MIN_SAMPLE_RATE,
        ...(latest !== undefined ? { latestObservationId: latest.observationId } : {}),
      } satisfies RouterInsightsSnapshotV0;
    }).pipe(Effect.mapError(toEvalError));

  const exportObservations: RouterEvaluationService["Service"]["exportObservations"] = (
    environmentId,
  ) =>
    Effect.gen(function* () {
      const records = yield* store.listByEnvironment(environmentId);
      const dataset = buildEvaluationDataset({ records, synthetic: false });
      return { manifest: dataset.manifest, records: [...dataset.train, ...dataset.evaluation] };
    }).pipe(Effect.mapError(toEvalError));

  const deleteObservations: RouterEvaluationService["Service"]["deleteObservations"] = (
    environmentId,
    input,
    actor,
  ) =>
    Effect.gen(function* () {
      if (input.confirmDelete !== true) {
        return yield* new RouterEvaluationError({
          reason: "confirmation_required",
          detail: "Delete requires confirmDelete=true and stays environment-scoped.",
        });
      }
      const deleted = yield* store.deleteByEnvironment(environmentId);
      yield* appendAudit({
        environmentId,
        eventType: "observations_deleted",
        recordedAt: "1970-01-01T00:00:00.000Z",
        idempotencyKey: `deleted:${deleted}:${actor ?? "unknown"}`,
        ...(actor !== undefined ? { actor } : {}),
        detail: `deleted ${deleted}`,
      });
      return { deleted };
    }).pipe(Effect.mapError(toEvalError));

  const submitFeedback: RouterEvaluationService["Service"]["submitFeedback"] = (
    environmentId,
    input,
    now,
    actor,
  ) =>
    Effect.gen(function* () {
      const existing = yield* store.get(input.observationId);
      if (Option.isNone(existing) || existing.value.environmentId !== environmentId) {
        return yield* new RouterEvaluationError({
          reason: "not_found",
          detail: "Observation not found in this environment.",
        });
      }
      const already = existing.value.evidence.explicitFeedback.some(
        (entry) => entry.kind === input.kind && entry.recordedAt === now,
      );
      if (already) {
        return { observationId: input.observationId, recorded: true };
      }
      const next = {
        ...existing.value,
        evidence: {
          ...existing.value.evidence,
          explicitFeedback: [
            ...existing.value.evidence.explicitFeedback,
            {
              kind: input.kind,
              ...(input.reasonCategory !== undefined
                ? { reasonCategory: input.reasonCategory }
                : {}),
              recordedAt: now,
              freeTextIncluded: false as const,
            },
          ].slice(-8),
        },
      };
      yield* store.replaceEvidence(next);
      yield* appendAudit({
        environmentId,
        eventType: "explicit_feedback",
        recordedAt: now,
        idempotencyKey: `feedback:${input.observationId}:${input.kind}`,
        observationId: input.observationId,
        ...(actor !== undefined ? { actor } : {}),
        detail: input.kind,
      });
      return { observationId: input.observationId, recorded: true };
    }).pipe(Effect.mapError(toEvalError));

  const recordReworkProxy: RouterEvaluationService["Service"]["recordReworkProxy"] = (
    environmentId,
    observationId,
    proxy,
  ) =>
    Effect.gen(function* () {
      const existing = yield* store.get(observationId);
      if (Option.isNone(existing) || existing.value.environmentId !== environmentId) return;
      if (
        existing.value.evidence.reworkProxies.some(
          (entry) => entry.kind === proxy.kind && entry.deduped === false,
        ) &&
        proxy.deduped
      ) {
        return;
      }
      const next = {
        ...existing.value,
        evidence: {
          ...existing.value.evidence,
          reworkProxies: [...existing.value.evidence.reworkProxies, proxy].slice(-16),
        },
      };
      yield* store.replaceEvidence(next);
      yield* appendAudit({
        environmentId,
        eventType: "rework_proxy",
        recordedAt: proxy.recordedAt,
        idempotencyKey: `rework:${observationId}:${proxy.kind}`,
        observationId,
        detail: proxy.kind,
      });
    }).pipe(Effect.mapError(toEvalError));

  const listPolicies: RouterEvaluationService["Service"]["listPolicies"] = (environmentId) =>
    Effect.gen(function* () {
      yield* ensureDefaults(environmentId, "1970-01-01T00:00:00.000Z");
      const policies = yield* store.listPolicies(environmentId);
      return { policies };
    }).pipe(store.transaction, Effect.mapError(toEvalError));

  const inspectPolicy: RouterEvaluationService["Service"]["inspectPolicy"] = (
    environmentId,
    policyId,
  ) =>
    Effect.gen(function* () {
      const policy = yield* store.getPolicy(policyId);
      if (Option.isNone(policy) || policy.value.environmentId !== environmentId) {
        return yield* new RouterEvaluationError({
          reason: "not_found",
          detail: "Policy not found in this environment.",
        });
      }
      return policy.value;
    }).pipe(Effect.mapError(toEvalError));

  const activate: RouterEvaluationService["Service"]["activate"] = (
    environmentId,
    input,
    authorized,
    now,
    actor,
    expectedRevision,
  ) =>
    Effect.gen(function* () {
      yield* validateMutation(environmentId, authorized, input.confirmActivation, expectedRevision);
      yield* ensureDefaults(environmentId, now);
      const candidate = yield* store.getPolicy(input.policyId);
      if (Option.isNone(candidate) || candidate.value.environmentId !== environmentId) {
        return yield* new RouterEvaluationError({
          reason: "not_found",
          detail: "Candidate policy not found.",
        });
      }
      const policies = yield* store.listPolicies(environmentId);
      const current = policies.find((policy) => policy.state === "active") ?? null;
      const result = yield* activatePolicy({
        candidate: candidate.value,
        currentActive: current,
        confirmActivation: input.confirmActivation,
        authorized,
        now,
        ...(actor !== undefined ? { actor } : {}),
      });
      yield* store.upsertPolicy(result.active);
      if (result.previous) yield* store.upsertPolicy(result.previous);
      yield* appendAudit({
        environmentId,
        eventType: "policy_activated",
        recordedAt: now,
        idempotencyKey: `activate:${result.active.policyId}:${yield* store.nextEventSequence(environmentId)}`,
        ...(actor !== undefined ? { actor } : {}),
        detail: result.active.policyVersion,
      });
      return result;
    }).pipe(store.transaction, Effect.mapError(toEvalError));

  const shadow: RouterEvaluationService["Service"]["shadow"] = (
    environmentId,
    input,
    authorized,
    now,
    actor,
    expectedRevision,
  ) =>
    Effect.gen(function* () {
      yield* validateMutation(environmentId, authorized, input.confirmShadow, expectedRevision);
      yield* ensureDefaults(environmentId, now);
      const candidate = yield* store.getPolicy(input.policyId);
      if (Option.isNone(candidate) || candidate.value.environmentId !== environmentId) {
        return yield* new RouterEvaluationError({
          reason: "not_found",
          detail: "Candidate policy not found.",
        });
      }
      if ((yield* store.listPolicies(environmentId)).some((policy) => policy.state === "shadow"))
        return yield* new RouterEvaluationError({
          reason: "illegal_transition",
          detail: "This environment already has a shadow policy.",
        });
      const result = yield* shadowPolicy({
        candidate: candidate.value,
        confirmShadow: input.confirmShadow,
        authorized,
        now,
        ...(actor !== undefined ? { actor } : {}),
      });
      yield* store.upsertPolicy(result.active);
      yield* appendAudit({
        environmentId,
        eventType: "policy_shadowed",
        recordedAt: now,
        idempotencyKey: `shadow:${result.active.policyId}:${yield* store.nextEventSequence(environmentId)}`,
        ...(actor !== undefined ? { actor } : {}),
        detail: result.active.policyVersion,
      });
      return result;
    }).pipe(store.transaction, Effect.mapError(toEvalError));

  const rollback: RouterEvaluationService["Service"]["rollback"] = (
    environmentId,
    input,
    authorized,
    now,
    actor,
    expectedRevision,
  ) =>
    Effect.gen(function* () {
      yield* validateMutation(environmentId, authorized, input.confirmRollback, expectedRevision);
      yield* ensureDefaults(environmentId, now);
      const policies = yield* store.listPolicies(environmentId);
      const current = policies.find((policy) => policy.state === "active");
      if (current === undefined) {
        return yield* new RouterEvaluationError({
          reason: "not_found",
          detail: "No active policy to roll back.",
        });
      }
      const prior =
        current.priorActivePolicyId === undefined
          ? null
          : (policies.find((policy) => policy.policyId === current.priorActivePolicyId) ?? null);
      if (
        (prior ?? policies.find((policy) => isBaselinePolicyVersion(policy.policyVersion)))
          ?.policyId === current.policyId
      )
        return yield* new RouterEvaluationError({
          reason: "illegal_transition",
          detail: "The baseline is already active; there is no prior policy to restore.",
        });
      const result = yield* rollbackPolicy({
        currentActive: current,
        prior,
        confirmRollback: input.confirmRollback,
        authorized,
        now,
        baseline:
          policies.find((policy) => isBaselinePolicyVersion(policy.policyVersion)) ??
          baselineSnapshot(environmentId, now),
        ...(actor !== undefined ? { actor } : {}),
      });
      yield* store.upsertPolicy(result.active);
      yield* store.upsertPolicy(result.previous);
      yield* appendAudit({
        environmentId,
        eventType: "policy_rolled_back",
        recordedAt: now,
        idempotencyKey: `rollback:${result.active.policyId}:${yield* store.nextEventSequence(environmentId)}`,
        ...(actor !== undefined ? { actor } : {}),
        detail: result.active.policyVersion,
      });
      return result;
    }).pipe(store.transaction, Effect.mapError(toEvalError));

  const evidenceMap: RouterEvaluationService["Service"]["evidenceMap"] = (environmentId) =>
    store
      .listByEnvironment(environmentId)
      .pipe(Effect.map(evidenceFromObservations), Effect.mapError(toEvalError));

  const control: RouterEvaluationService["Service"]["control"] = (
    environmentId,
    input,
    now,
    actor,
  ) =>
    store
      .transaction(
        Effect.gen(function* () {
          switch (input.action) {
            case "shadow":
              yield* shadow(
                environmentId,
                { policyId: input.policyId, confirmShadow: input.confirm },
                true,
                now,
                actor,
                input.expectedRevision,
              );
              break;
            case "activate":
              yield* activate(
                environmentId,
                { policyId: input.policyId, confirmActivation: input.confirm },
                true,
                now,
                actor,
                input.expectedRevision,
              );
              break;
            case "rollback":
              yield* rollback(
                environmentId,
                { confirmRollback: input.confirm },
                true,
                now,
                actor,
                input.expectedRevision,
              );
              break;
          }
          return yield* readStatus(environmentId);
        }),
      )
      .pipe(Effect.mapError(toEvalError));

  return {
    control,
    status,
    routingSnapshot,
    insights,
    exportObservations,
    deleteObservations,
    submitFeedback,
    recordReworkProxy,
    listPolicies,
    inspectPolicy,
    activate,
    shadow,
    rollback,
    evidenceMap,
    recordObservation: (observation, context) =>
      store.upsert(observation, context).pipe(Effect.asVoid, Effect.mapError(toEvalError)),
    latestObservationForThread: (environmentId, threadId, exceptObservationId) =>
      store
        .latestForThread(environmentId, threadId, exceptObservationId)
        .pipe(Effect.mapError(toEvalError)),
    observationCount: (environmentId) =>
      store.countByEnvironment(environmentId).pipe(Effect.mapError(toEvalError)),
    activePolicyVersion: (environmentId) =>
      Effect.gen(function* () {
        const policies = yield* store.listPolicies(environmentId);
        return (
          policies.find((policy) => policy.state === "active")?.policyVersion ??
          MODEL_ROUTER_POLICY_VERSION
        );
      }).pipe(Effect.mapError(toEvalError)),
  } satisfies RouterEvaluationService["Service"];
});

export const layer = Layer.effect(RouterEvaluationService, make).pipe(
  Layer.provide(observationRepositoryLayer),
);
