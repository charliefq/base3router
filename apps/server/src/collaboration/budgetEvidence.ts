/** Read-only projection. Call only after validating the root's sealed task link. */
import {
  OrchestrationV2AppThreadJson,
  SYNTHETIC_FIXTURE_PRICE_LABEL,
  type CollaborationTaskBudgetReadout,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
const tokenCount = (n: number | null): n is number => finite(n) && Number.isSafeInteger(n);

export const readBudgetEvidence = (
  sql: SqlClient.SqlClient,
  input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly owns: (threadId: string) => boolean;
  },
) =>
  Effect.gen(function* () {
    const no = (reason: string): CollaborationTaskBudgetReadout => ({
      status: "unavailable",
      reason,
    });
    const observedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const rows = yield* sql<{
      thread_id: string;
      project_id: string;
      provider_instance_id: string;
      payload_json: string;
    }>`
    SELECT thread_id,project_id,provider_instance_id,payload_json FROM orchestration_v2_projection_threads
    WHERE thread_id=${input.threadId}
      OR (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.lineage.rootThreadId') END)=${input.threadId}
      OR thread_id IN (SELECT thread_id FROM task_contract_members WHERE root_thread_id=${input.threadId})
  `;
    const decoded = rows.map((row) => ({ row, decoded: decodeThread(row.payload_json) }));
    const rootNode = decoded.find((n) => n.row.thread_id === input.threadId);
    if (rootNode?.decoded._tag !== "Some") return no("invalid_root_evidence");
    const root = rootNode.decoded.value;
    if (root.taskGovernance !== "required") return no("ordinary_chat");
    if (!root.taskContract) return no("missing_contract");
    if (
      root.id !== input.threadId ||
      root.projectId !== input.projectId ||
      root.lineage.rootThreadId !== root.id ||
      root.lineage.parentThreadId !== null ||
      root.lineage.relationshipToParent !== null ||
      root.forkedFrom !== null ||
      !input.owns(root.id)
    )
      return no("invalid_root_binding");
    const members = yield* sql<{
      thread_id: string;
      parent_thread_id: string | null;
    }>`SELECT thread_id,parent_thread_id FROM task_contract_members WHERE root_thread_id=${root.id}`;
    // SQL includes raw root claims and registered members. A failed codec is
    // evidence of an incomplete tree, not permission to drop that descendant.
    const invalidCandidates = decoded.filter((node) => node.decoded._tag === "None");
    if (invalidCandidates.length > 0)
      return no(
        invalidCandidates.every((node) =>
          members.some((member) => member.thread_id === node.row.thread_id),
        )
          ? "invalid_member_binding"
          : "invalid_tree_binding",
      );
    const tree = decoded.filter(
      (n) => n.decoded._tag === "Some" && n.decoded.value.lineage.rootThreadId === root.id,
    );
    const nodes = new Map(
      tree.flatMap((n) => (n.decoded._tag === "Some" ? [[n.row.thread_id, n] as const] : [])),
    );
    const validNode = (id: string): boolean => {
      const seen = new Set<string>();
      let next: string | null = id;
      while (next !== null) {
        if (seen.has(next)) return false;
        seen.add(next);
        const node = nodes.get(next);
        if (node?.decoded._tag !== "Some") return false;
        const t = node.decoded.value;
        if (
          t.id !== next ||
          t.projectId !== input.projectId ||
          node.row.project_id !== t.projectId ||
          node.row.provider_instance_id !== t.providerInstanceId ||
          t.modelSelection.instanceId !== t.providerInstanceId ||
          t.taskGovernance !== "required" ||
          !t.taskContract ||
          !input.owns(next)
        )
          return false;
        if (next === root.id)
          return t.lineage.parentThreadId === null && t.lineage.relationshipToParent === null;
        if (t.lineage.parentThreadId === null || t.lineage.relationshipToParent === null)
          return false;
        next = t.lineage.parentThreadId;
      }
      return false;
    };
    if ([...nodes.keys()].some((id) => !validNode(id))) return no("invalid_tree_binding");
    if (
      members.some((m) => {
        const node = nodes.get(m.thread_id);
        return (
          !validNode(m.thread_id) ||
          node?.decoded._tag !== "Some" ||
          node.decoded.value.lineage.parentThreadId !== m.parent_thread_id
        );
      })
    )
      return no("invalid_member_binding");
    const admissions = yield* sql<{
      thread_id: string;
      message_id: string | null;
      contract_revision: number;
    }>`SELECT thread_id,message_id,contract_revision FROM task_contract_admissions WHERE root_thread_id=${root.id}`;
    const attempts = yield* sql<{
      environment_id: string;
      provider_turn_id: string;
      thread_id: string;
      provider_instance_id: string | null;
      message_id: string | null;
      usage_status: string;
      input_tokens: number | null;
      output_tokens: number | null;
      reported_cost_usd: number | null;
      price_verified: number;
      price_label: string | null;
    }>`SELECT environment_id,provider_turn_id,thread_id,provider_instance_id,message_id,usage_status,input_tokens,output_tokens,reported_cost_usd,price_verified,price_label FROM task_usage_attempts WHERE root_thread_id=${root.id}`;
    if (
      admissions.some((a) => !validNode(a.thread_id)) ||
      attempts.some((a) => a.environment_id !== input.environmentId || !validNode(a.thread_id))
    )
      return no("inconsistent_tree_accounting");
    const turns = yield* sql<{
      thread_id: string;
      provider_turn_id: string;
      provider_instance_id: string | null;
    }>`SELECT turn.thread_id,turn.provider_turn_id,provider.provider_instance_id
      FROM orchestration_v2_projection_provider_turns AS turn
      LEFT JOIN orchestration_v2_projection_provider_threads AS provider
        ON provider.provider_thread_id=turn.provider_thread_id AND provider.thread_id=turn.thread_id
      WHERE ${sql.in("turn.thread_id", [...nodes.keys()])}`;
    if (
      attempts.some((a) =>
        turns.some(
          (t) =>
            t.provider_turn_id === a.provider_turn_id &&
            t.thread_id === a.thread_id &&
            t.provider_instance_id !== null &&
            t.provider_instance_id !== a.provider_instance_id,
        ),
      )
    )
      return no("inconsistent_provider_accounting");
    const orphanAttempt = attempts.some(
      (a) =>
        !turns.some(
          (t) =>
            t.thread_id === a.thread_id &&
            t.provider_turn_id === a.provider_turn_id &&
            t.provider_instance_id === a.provider_instance_id &&
            t.provider_instance_id !== null,
        ),
    );
    const missingTurn = turns.some(
      (t) =>
        nodes.has(t.thread_id) &&
        !attempts.some(
          (a) => a.provider_turn_id === t.provider_turn_id && a.thread_id === t.thread_id,
        ),
    );
    const bounds = yield* sql<{
      deadline_at: string;
      frozen_at: string;
      max_tokens: number | null;
      max_cost_usd: number | null;
    }>`SELECT deadline_at,frozen_at,max_tokens,max_cost_usd FROM task_contract_deadlines WHERE root_thread_id=${root.id}`;
    const bound = bounds[0];
    if (
      bound &&
      (!Number.isFinite(Date.parse(bound.deadline_at)) ||
        !Number.isFinite(Date.parse(bound.frozen_at)) ||
        (bound.max_tokens !== null && (!tokenCount(bound.max_tokens) || bound.max_tokens < 1)) ||
        (bound.max_cost_usd !== null && (!finite(bound.max_cost_usd) || bound.max_cost_usd <= 0)))
    )
      return no("invalid_frozen_bounds");
    const brake = root.taskContract.brake;
    const unsettled =
      admissions.length !==
      attempts.filter(
        (a) =>
          a.usage_status === "complete" &&
          tokenCount(a.input_tokens) &&
          tokenCount(a.output_tokens) &&
          finite(a.reported_cost_usd) &&
          a.price_verified === 1 &&
          a.price_label === SYNTHETIC_FIXTURE_PRICE_LABEL,
      ).length;
    // Equal row counts alone cannot settle unrelated reservations. Missing message
    // linkage remains partial; revision edits never partition or reset the totals.
    const reservationCoverage = admissions.every(
      (a) =>
        a.message_id !== null &&
        admissions.filter((b) => b.thread_id === a.thread_id && b.message_id === a.message_id)
          .length ===
          attempts.filter((b) => b.thread_id === a.thread_id && b.message_id === a.message_id)
            .length,
    );
    const tokensComplete =
      !missingTurn &&
      !orphanAttempt &&
      reservationCoverage &&
      admissions.length === attempts.length &&
      attempts.every(
        (a) =>
          a.usage_status === "complete" &&
          tokenCount(a.input_tokens) &&
          tokenCount(a.output_tokens),
      );
    const priceVerified = attempts.every(
      (a) =>
        finite(a.reported_cost_usd) &&
        a.price_verified === 1 &&
        a.price_label === SYNTHETIC_FIXTURE_PRICE_LABEL,
    );
    const components = attempts
      .flatMap((a) => [a.input_tokens, a.output_tokens])
      .filter(tokenCount);
    const costs = attempts.map((a) => a.reported_cost_usd).filter(finite);
    const tokens = components.length
      ? components.reduce((a, b) => a + b, 0)
      : tokensComplete
        ? 0
        : null;
    const cost = costs.length
      ? costs.reduce((a, b) => a + b, 0)
      : tokensComplete && attempts.length === 0
        ? 0
        : null;
    if ((tokens !== null && !tokenCount(tokens)) || (cost !== null && !finite(cost)))
      return no("invalid_usage_totals");
    const issues: string[] = [];
    if (root.taskContractPhase === "redirected") issues.push("paused");
    if (root.taskAcceptedRevision === root.taskContract.revision) issues.push("accepted");
    if (admissions.length >= brake.maxProviderStarts) issues.push("start_exhausted");
    const budgeted =
      bound !== undefined ||
      brake.maxTokens !== undefined ||
      brake.maxCostUsd !== undefined ||
      brake.deadlineAt !== undefined;
    if (budgeted && !bound) issues.push("required_bound_missing");
    if (bound && bound.deadline_at <= observedAt) issues.push("deadline_expired");
    if (budgeted && !tokensComplete) issues.push("usage_incomplete");
    if (budgeted && !priceVerified) issues.push("unverified_price");
    if (bound?.max_tokens != null && tokens !== null && tokens >= bound.max_tokens)
      issues.push("token_exhausted");
    if (bound?.max_cost_usd != null && cost !== null && priceVerified && cost >= bound.max_cost_usd)
      issues.push("cost_exhausted");
    if (budgeted && unsettled) issues.push("unsettled_reservation");
    const result: CollaborationTaskBudgetReadout = {
      status: "available",
      taskId: input.taskId,
      threadId: root.id,
      rootThreadId: root.id,
      environmentId: input.environmentId,
      contractRevision: root.taskContract.revision,
      observedAt,
      reservedStarts: admissions.length,
      declaredStarts: brake.maxProviderStarts,
      remainingStarts: Math.max(0, brake.maxProviderStarts - admissions.length),
      declared: {
        tokens: brake.maxTokens ?? null,
        costUsd: brake.maxCostUsd ?? null,
        deadline: brake.deadlineAt ?? null,
      },
      frozen: bound
        ? {
            tokens: bound.max_tokens,
            costUsd: bound.max_cost_usd,
            deadline: bound.deadline_at,
            frozenAt: bound.frozen_at,
          }
        : null,
      usage: {
        status: tokensComplete
          ? "complete"
          : tokens === null && cost === null
            ? "unknown"
            : "partial",
        attempts: attempts.length,
        reportedTokens: tokens,
        reportedCostUsd: cost,
        priceStatus:
          attempts.length === 0
            ? "no_attempts"
            : priceVerified
              ? "synthetic_verified"
              : "unverified",
        remainingTokens:
          tokensComplete && !unsettled && bound?.max_tokens != null && tokens !== null
            ? Math.max(0, bound.max_tokens - tokens)
            : null,
        verifiedRemainingCostUsd:
          tokensComplete &&
          !unsettled &&
          priceVerified &&
          attempts.length > 0 &&
          bound?.max_cost_usd != null &&
          cost !== null
            ? Math.max(0, bound.max_cost_usd - cost)
            : null,
      },
      issues,
    };
    return result;
  }).pipe(
    Effect.catch(() =>
      Effect.succeed<CollaborationTaskBudgetReadout>({
        status: "unavailable",
        reason: "budget_read_failed",
      }),
    ),
  );
