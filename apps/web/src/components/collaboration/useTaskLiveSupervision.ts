import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CollaborationTask, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEnvironmentShellState } from "../../state/shell";

const MAX_VISIBLE_DETAILS = 8;
/** One shared shell subscription plus at most eight visible task detail subscriptions. */
export function useTaskLiveSupervision(input: {
  environmentId: EnvironmentId | null;
  tasks: ReadonlyArray<CollaborationTask>;
  detailTasks?: ReadonlyArray<CollaborationTask>;
  context: object;
  refresh: () => Promise<unknown> | undefined;
  invalidate: () => void;
}) {
  const context = input.context;
  const shell = useEnvironmentShellState(input.environmentId);
  const live =
    input.environmentId !== null && shell.status === "live" && Option.isNone(shell.error);
  const latest = useRef({ ...input, live });
  const cycle = useRef({
    context,
    epoch: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    pending: false,
    dirty: false,
  });
  useLayoutEffect(() => {
    latest.current = { ...input, live };
  });
  const schedule = useCallback(function scheduleRefresh() {
    const current = cycle.current;
    current.dirty = true;
    if (!latest.current.live || current.pending || current.timer !== null) return;
    const epoch = current.epoch;
    current.timer = setTimeout(() => {
      current.timer = null;
      if (current.epoch !== epoch || !latest.current.live) return;
      current.pending = true;
      current.dirty = false;
      void Promise.resolve()
        .then(() =>
          current.epoch === epoch && latest.current.live ? latest.current.refresh() : undefined,
        )
        .catch(() => {
          if (current.epoch === epoch) latest.current.invalidate();
        })
        .finally(() => {
          if (current.epoch !== epoch) return;
          current.pending = false;
          if (current.dirty) scheduleRefresh();
        });
    }, 100);
  }, []);
  useLayoutEffect(() => {
    const current = cycle.current;
    current.context = context;
    current.epoch++;
    current.pending = false;
    current.dirty = false;
    return () => {
      current.epoch++;
      if (current.timer !== null) clearTimeout(current.timer);
      current.timer = null;
    };
  }, [context]);
  const ids = input.tasks.flatMap((task) => (task.threadId ? [task.threadId] : []));
  const idsKey = JSON.stringify(ids);
  const linked = new Set(ids);
  const signature = JSON.stringify(
    Option.getOrNull(shell.snapshot)
      ?.threads.filter((thread) => linked.has(thread.id))
      .map((thread) => [
        thread.id,
        thread.status,
        thread.activeRunId,
        thread.latestRunId,
        thread.latestRunCompletedAt,
      ]) ?? [],
  );
  const observed = useRef({ context, live, signature, idsKey });
  useEffect(() => {
    const prior = observed.current;
    observed.current = { context, live, signature, idsKey };
    if (!live) {
      latest.current.invalidate();
      return;
    }
    // A new directory scope owns its initial GET. Token updates never enter this signature.
    if (
      prior.context === context &&
      (!prior.live || (prior.idsKey === idsKey && prior.signature !== signature))
    )
      schedule();
  }, [context, live, signature, idsKey, schedule, observed]);
  const nodes = useRef(new Map<Element, string>());
  const observer = useRef<IntersectionObserver | null>(null);
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const visibilityReady = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const instance = new IntersectionObserver(
      (entries) => {
        setVisible((prior) => {
          const next = new Set(prior);
          for (const entry of entries) {
            const id = nodes.current.get(entry.target);
            if (!id) continue;
            if (entry.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next.size === prior.size && [...next].every((id) => prior.has(id)) ? prior : next;
        });
      },
      { rootMargin: "200px" },
    );
    observer.current = instance;
    for (const node of nodes.current.keys()) instance.observe(node);
    return () => {
      instance.disconnect();
      observer.current = null;
    };
  }, []);
  const observe = useCallback((node: Element | null, id: string, previous: Element | null) => {
    if (previous) {
      observer.current?.unobserve(previous);
      nodes.current.delete(previous);
    }
    if (node) {
      nodes.current.set(node, id);
      observer.current?.observe(node);
    }
  }, []);
  const watched = new Set(
    (input.detailTasks ?? input.tasks)
      .flatMap((task) => (task.threadId ? [task.threadId] : []))
      .filter((id) => !visibilityReady || visible.has(id))
      .slice(0, MAX_VISIBLE_DETAILS),
  );
  return { live, watched, observe, changed: schedule };
}
