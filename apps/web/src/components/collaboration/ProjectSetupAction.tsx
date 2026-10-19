import { useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNewProject } from "../../hooks/useNewProject";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
/** Uses the existing local project creation command, without publishing or opening a draft. */
export function ProjectSetupAction({
  environmentId,
  enabled,
}: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
}) {
  const createProject = useNewProject();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef<object | null>(null);
  const active = useRef(false);
  const context = {};
  const latest = useRef<object | null>(null);
  useLayoutEffect(() => {
    latest.current = context;
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      owner.current = null;
    };
  }, []);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled || pending}
        onClick={() => setOpen(true)}
      >
        Create a project
      </Button>
      {open ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !active.current ||
              latest.current !== context ||
              !environmentId ||
              !enabled ||
              owner.current ||
              !name.trim()
            )
              return;
            const token = {};
            owner.current = token;
            setPending(true);
            setError(null);
            void createProject({
              environmentId,
              name: name.trim(),
              github: null,
              openDraft: false,
            })
              .then((created) => {
                if (owner.current !== token) return;
                owner.current = null;
                setPending(false);
                if (created) {
                  setOpen(false);
                  setName("");
                }
              })
              .catch(() => {
                if (owner.current !== token) return;
                owner.current = null;
                setPending(false);
                setError(
                  "Project creation could not be confirmed. Check your projects before trying again.",
                );
              });
          }}
        >
          <Input
            aria-label="New project name"
            value={name}
            disabled={pending || !enabled}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={pending || !enabled || !name.trim()}>
            Create local project
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              setName("");
            }}
          >
            Cancel project setup
          </Button>
        </form>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
