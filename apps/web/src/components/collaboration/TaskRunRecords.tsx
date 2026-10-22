import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  RunId,
  ThreadId,
  type EnvironmentId,
  type TaskRunRecordsPage,
  type TaskRunRecordDetail,
  type TaskRunRecord,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePreparedConnection } from "../../state/session";
import { useEnvironmentShellState } from "../../state/shell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { duration, elapsedMs, executedModels, recordEta, recordUsage } from "./taskRunRecordFacts";

function Usage({ record }: { record: TaskRunRecord }) {
  const usage = recordUsage(record);
  return (
    <span>
      {usage.total === null
        ? "Unavailable"
        : `${usage.total.toLocaleString()} actual${usage.complete ? "" : " (partial)"}`}
      <span className="block text-xs text-muted-foreground">
        Provider main-agent usage{usage.subagents ? "; subagent usage may be missing" : ""}
      </span>
    </span>
  );
}
export function TaskRunRecords({ environmentId }: { environmentId: EnvironmentId | null }) {
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const shell = useEnvironmentShellState(environmentId);
  const live = shell.status === "live" && Option.isNone(shell.error);
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const threadId =
    "recordThreadId" in search && typeof search.recordThreadId === "string"
      ? search.recordThreadId
      : null;
  const runId =
    "recordRunId" in search && typeof search.recordRunId === "string" ? search.recordRunId : null;
  const selectionMatches =
    "recordEnvironmentId" in search && search.recordEnvironmentId === environmentId;
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<{
    connection: typeof connection;
    offset: number;
    at: number;
    value: TaskRunRecordsPage;
  } | null>(null);
  const [detail, setDetail] = useState<{
    key: string;
    connection: typeof connection;
    value: TaskRunRecordDetail;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([environmentId, threadId, runId]);
  useEffect(() => {
    if (!environmentId || !connection || !live) return;
    let valid = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const value = await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) =>
              client.orchestration.taskRecords({
                headers: { "x-t3-orchestration-protocol": "2" },
                query: { offset },
              }),
            ),
          ),
        );
        if (valid) {
          setPage({ connection, offset, at: Date.now(), value });
          setError(null);
        }
        if (!valid) return;
        if (threadId && runId && selectionMatches) {
          const value = await runPrimaryHttp(
            PrimaryEnvironmentHttpClient.pipe(
              Effect.flatMap((client) =>
                client.orchestration.taskRecord({
                  headers: { "x-t3-orchestration-protocol": "2" },
                  params: { threadId: ThreadId.make(threadId), runId: RunId.make(runId) },
                }),
              ),
            ),
          );
          if (valid)
            setDetail({ key: JSON.stringify([environmentId, threadId, runId]), connection, value });
        }
      } catch {
        if (valid) {
          setError(
            "Could not refresh run records or selected detail. It may have been deleted. Retry to reconnect.",
          );
          setDetail(null);
        }
      } finally {
        pending = false;
        if (valid) setLoading(false);
      }
    };
    void load();
    // At most one page and one selected detail per refresh; no per-row subscriptions.
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 5000);
    return () => {
      valid = false;
      clearInterval(timer);
    };
  }, [connection, environmentId, live, offset, tick, threadId, runId, selectionMatches]);
  const records =
    page?.connection === connection && page.offset === offset ? page.value.records : [];
  const observedNow = live && !error ? now : (page?.at ?? now);
  const selected =
    selectionMatches && detail?.key === key && detail.connection === connection
      ? detail.value
      : null;
  const open = (record: TaskRunRecord | null) =>
    void navigate({
      to: "/tasks",
      search: (previous) => ({
        ...previous,
        recordEnvironmentId: record ? (environmentId ?? undefined) : undefined,
        recordThreadId: record?.run.threadId,
        recordRunId: record?.run.id,
      }),
      replace: false,
    });
  return (
    <section className="space-y-4" aria-label="Run records">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Task & run records</h2>
          <p className="text-sm text-muted-foreground">
            All retained B3R V2 runs in this environment, including ordinary chats, governed tasks
            and archived conversations. External tasks and deleted conversations are excluded.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTick((v) => v + 1)}
          disabled={loading || !live}
        >
          Refresh
        </Button>
      </div>
      {!live ? (
        <p role="status">
          Disconnected. Records may be stale; progress and elapsed times are paused.
        </p>
      ) : null}
      {error ? (
        <p role="alert">
          {error}{" "}
          <Button variant="outline" size="sm" onClick={() => setTick((v) => v + 1)}>
            Retry
          </Button>
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing persisted records…
        </p>
      ) : null}
      <Input
        aria-label="Search records on this page"
        placeholder="Search this page by task, model or status"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40">
            <tr>
              {[
                "Task / run",
                "Executed model · provider",
                "Status",
                "Elapsed",
                "Remaining",
                "Tokens",
              ].map((label) => (
                <th key={label} className="p-3 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records
              .filter((record) =>
                `${record.title} ${record.goal} ${executedModels(record).join(" ")} ${record.run.status}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((record) => {
                const models = executedModels(record);
                const eta = recordEta(record, records, observedNow);
                return (
                  <tr key={record.run.id} className="border-t align-top">
                    <td className="max-w-64 p-3">
                      <button
                        type="button"
                        className="text-left font-medium underline underline-offset-4"
                        onClick={() => open(record)}
                      >
                        {record.title} · #{record.run.ordinal}
                      </button>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {record.goal ?? "Goal not recorded"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {record.governance === "required" ? "Governed task" : "Conversation run"}
                      </p>
                    </td>
                    <td className="max-w-64 p-3">
                      {models.length ? models.join("; ") : "No execution recorded"}
                      <p className="text-xs text-muted-foreground">
                        Requested: {record.run.providerInstanceId} ·{" "}
                        {record.run.modelSelection.model}
                      </p>
                    </td>
                    <td className="p-3">
                      {record.run.status}
                      {record.run.queueHeld ? " (held)" : ""}
                    </td>
                    <td className="p-3">
                      {record.run.startedAt
                        ? duration(elapsedMs(record, observedNow))
                        : "Not started"}
                    </td>
                    <td className="max-w-60 p-3">
                      {eta.remainingMs === null ? "—" : `~${duration(eta.remainingMs)}`}
                      <p className="text-xs text-muted-foreground">{eta.basis}</p>
                    </td>
                    <td className="p-3">
                      <Usage record={record} />
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {!loading &&
      live &&
      !error &&
      page?.connection === connection &&
      page.offset === offset &&
      records.length === 0 ? (
        <p>No retained runs on this page. Send a message or start a task to create a record.</p>
      ) : null}
      <div className="flex gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0 || loading}
          onClick={() => setOffset((v) => Math.max(0, v - 50))}
        >
          Newer
        </Button>
        <span className="text-sm">Page {Math.floor(offset / 50) + 1}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={
            loading ||
            page?.connection !== connection ||
            page.offset !== offset ||
            page.value.nextOffset == null
          }
          onClick={() => setOffset(page?.value.nextOffset ?? 0)}
        >
          Older
        </Button>
      </div>
      {runId && threadId ? (
        <section className="space-y-3 rounded-xl border p-4" aria-label="Run detail">
          <div className="flex justify-between">
            <h3 className="font-semibold">Run detail</h3>
            <Button size="sm" variant="ghost" onClick={() => open(null)}>
              Close detail
            </Button>
          </div>
          {!selected ? (
            <p>
              {loading
                ? "Loading record…"
                : selectionMatches
                  ? "Record unavailable. Retry or select another run."
                  : "Saved run belongs to another environment or has no environment identity. Choose a record here."}
            </p>
          ) : (
            <>
              <h4>
                {selected.record.title} · #{selected.record.run.ordinal} ·{" "}
                {selected.record.run.status}
              </h4>
              <p className="whitespace-pre-wrap">{selected.record.goal ?? "Goal unavailable"}</p>
              <p>
                Requested: {selected.record.run.providerInstanceId} ·{" "}
                {selected.record.run.modelSelection.model}
              </p>
              <p>
                Confirmed execution: {executedModels(selected.record).join("; ") || "Not reported"}
              </p>
              <p>
                Tokens: <Usage record={selected.record} />
              </p>
              <p className="text-sm">
                Requested {DateTime.formatIso(selected.record.run.requestedAt)}; started{" "}
                {selected.record.run.startedAt
                  ? DateTime.formatIso(selected.record.run.startedAt)
                  : "not recorded"}
                ; finished{" "}
                {selected.record.run.completedAt
                  ? DateTime.formatIso(selected.record.run.completedAt)
                  : "not recorded"}
                .
              </p>
              <p>
                Contract revision: {selected.record.revision ?? "Not retained on this run"}. Each
                send/continuation is a separate run; attempts below belong to this run.
              </p>
              <h4 className="font-medium">Attempts</h4>
              {selected.record.attempts.length ? (
                <ol>
                  {selected.record.attempts.map((attempt) => (
                    <li key={attempt.id}>
                      #{attempt.attemptOrdinal} · {attempt.reason} · {attempt.providerInstanceId} ·{" "}
                      {attempt.status}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No attempt recorded.</p>
              )}
              <h4 className="font-medium">Process, results & errors</h4>
              {selected.hasMoreSteps ? (
                <p>Showing the latest 200 entries. Open conversation for the full history.</p>
              ) : null}
              {selected.steps.length ? (
                <ol className="space-y-3">
                  {selected.steps.map((step) => (
                    <li key={step.id} className="rounded border p-3">
                      <p className="text-xs text-muted-foreground">
                        {step.type} · {step.status} · {DateTime.formatIso(step.updatedAt)}
                      </p>
                      <p className="whitespace-pre-wrap break-words">
                        {step.type === "error"
                          ? step.failure.message
                          : "text" in step
                            ? step.text
                            : "message" in step
                              ? step.message
                              : (step.title ?? "Recorded activity")}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No process entries recorded yet.</p>
              )}
              <Button
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: {
                      environmentId: environmentId!,
                      threadId: selected.record.run.threadId,
                    },
                  })
                }
              >
                Open conversation · stop / retry
              </Button>
            </>
          )}
        </section>
      ) : null}
    </section>
  );
}
