import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { Button } from "../ui/button";
import { validateSetupReturn } from "./collaborationScope";
/** Return only to one of the two internal work pages; scope is revalidated there. */
export function SetupReturnAction({ search }: { search: Record<string, unknown> }) {
  const navigate = useNavigate();
  const pending = useRef(false);
  const target = validateSetupReturn(search);
  const active = useRef(false);
  const latest = useRef<typeof target | null>(null);
  useLayoutEffect(() => {
    latest.current = target;
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  if (!target.returnPage) return null;
  const { returnPage, ...scope } = target;
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        if (!active.current || pending.current || latest.current !== target) return;
        pending.current = true;
        return navigate({
          to: returnPage === "agents" ? "/agents" : "/tasks",
          search: () => scope,
        }).finally(() => {
          pending.current = false;
        });
      }}
    >
      Return to {returnPage === "agents" ? "Agents" : "Tasks"}
    </Button>
  );
}
