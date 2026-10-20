import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { CollaborationTask } from "@t3tools/contracts";
import type { TaskInstructionDraft } from "./TaskInstructionEditor";
// Only inert text drafts survive a focused detail unmount. Never retain reviews,
// confirmations, dispatch commands or proof tokens here; existing recovery stores own identities.
type InertDraft =
  | string
  | null
  | { identity: string; draft: TaskInstructionDraft }
  | ReadonlyMap<string, string>;
const Drafts = createContext<Map<string, InertDraft> | null>(null);
export function TaskInboxDrafts({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new Map<string, InertDraft>());
  return <Drafts.Provider value={cache}>{children}</Drafts.Provider>;
}
export function useTaskInboxDraft<T extends InertDraft>(
  namespace: string,
  props: { environmentId: string; task: CollaborationTask },
  initial: T,
): [T, (next: SetStateAction<T>) => void] {
  const cache = useContext(Drafts);
  const key = JSON.stringify([
    props.environmentId,
    props.task.projectId,
    props.task.id,
    props.task.threadId,
    namespace,
  ]);
  const [value, setValue] = useState<T>(() => (cache?.has(key) ? (cache.get(key) as T) : initial));
  const current = useRef(value);
  return [
    value,
    (next) => {
      const resolved = typeof next === "function" ? next(current.current) : next;
      current.current = resolved;
      cache?.set(key, resolved);
      setValue(resolved);
    },
  ];
}
