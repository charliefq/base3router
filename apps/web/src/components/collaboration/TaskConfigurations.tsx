import {
  AgentProfile,
  WorkflowActionInput,
  type AgentConfigurationSnapshot,
  type EnvironmentId,
  type ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { configurationSnapshot } from "@t3tools/shared/agentConfiguration";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useLayoutEffect, useRef, useState } from "react";
import { workflowEnvironment } from "../../state/workflow";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
const key = "t3:saved-task-configuration-command:v1";
const Attempt = Schema.Struct({ environmentId: Schema.String, command: WorkflowActionInput });
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Attempt));
const encode = Schema.encodeSync(Schema.fromJsonString(Attempt));
function retained() {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { attempt: null, error: null };
    const result = decode(raw);
    if (
      result._tag === "None" ||
      !["profile.save", "profile.archive", "profile.restore"].includes(result.value.command.type)
    )
      throw new Error();
    return { attempt: result.value, error: null };
  } catch {
    return {
      attempt: null,
      error: "Configuration recovery storage is unreadable. Writes remain blocked.",
    };
  }
}
type Props = {
  environmentId: EnvironmentId | null;
  projectId: string | undefined;
  modelSelection: ModelSelection | null;
  open: boolean;
  disabled: boolean;
  onSelect: (value: AgentConfigurationSnapshot | null) => void;
  onBlocked: (value: boolean) => void;
};
export function TaskConfigurations(props: Props) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const [identity, setIdentity] = useState({ session, revision: 0 });
  if (identity.session !== session) setIdentity({ session, revision: identity.revision + 1 });
  return (
    <ConfigurationEditor
      {...props}
      key={`${props.environmentId}:${props.projectId}:${identity.revision}`}
      session={session}
    />
  );
}
function ConfigurationEditor(
  props: Props & {
    session: import("@t3tools/client-runtime/connection").PreparedConnection | null;
  },
) {
  const read = useAtomCommand(workflowEnvironment.readCatalog, { reportFailure: false });
  const write = useAtomCommand(workflowEnvironment.configurationAction, { reportFailure: false });
  const status = useAtomCommand(workflowEnvironment.configurationStatus, { reportFailure: false });
  const session = props.session;
  const [initial] = useState(retained);
  const [attempt, setAttempt] = useState(initial.attempt);
  const attemptRef = useRef(attempt);
  const [notice, setNotice] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<ReadonlyArray<AgentProfile>>([]);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const generation = useRef(0);
  const owner = useRef<object | null>(null);
  const { onBlocked } = props;
  const blocked = attempt !== null || initial.error !== null;
  useLayoutEffect(
    () => () => {
      generation.current++;
      owner.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    onBlocked(blocked);
  }, [blocked, onBlocked]);
  const latest = new Map<string, AgentProfile>();
  for (const profile of profiles)
    if (
      profile.taskConfiguration &&
      (!latest.has(profile.id) || latest.get(profile.id)!.version < profile.version)
    )
      latest.set(profile.id, profile);
  const load = async () => {
    if (!props.environmentId || !props.projectId || !session || owner.current) return;
    const token = {};
    owner.current = token;
    const epoch = generation.current;
    setBusy(true);
    try {
      const result = await read({
        environmentId: props.environmentId,
        input: { projectId: ProjectId.make(props.projectId) },
      });
      if (generation.current !== epoch) return;
      if (result._tag === "Success") setProfiles(result.value.profiles);
      else setNotice("Saved configurations are unavailable. No selection was substituted.");
    } finally {
      if (owner.current === token) {
        owner.current = null;
        setBusy(false);
      }
    }
  };
  const send = async (command: WorkflowActionInput) => {
    if (
      !props.environmentId ||
      !props.projectId ||
      !session ||
      owner.current ||
      retained().attempt ||
      retained().error ||
      props.disabled
    )
      return;
    const original = { environmentId: props.environmentId, command };
    try {
      sessionStorage.setItem(key, encode(original));
      if (sessionStorage.getItem(key) !== encode(original)) throw new Error();
    } catch {
      setNotice("Original configuration command could not be retained. Nothing was sent.");
      props.onBlocked(true);
      return;
    }
    attemptRef.current = original;
    setAttempt(original);
    props.onBlocked(true);
    props.onSelect(null);
    const token = {};
    owner.current = token;
    const epoch = generation.current;
    setBusy(true);
    try {
      const result = await write({ environmentId: props.environmentId, input: command });
      if (generation.current !== epoch || attemptRef.current !== original) return;
      if (result._tag === "Success") {
        sessionStorage.removeItem(key);
        attemptRef.current = null;
        setAttempt(null);
        setProfiles(result.value.profiles);
        setEditing(null);
        setName("");
        setInstructions("");
        setNotice(
          "Configuration recorded. Select its exact revision explicitly. No provider work started.",
        );
      } else
        setNotice(
          "Configuration outcome UNKNOWN or rejected. Recover the original command; no resend is automatic.",
        );
    } catch {
      if (generation.current === epoch)
        setNotice("Configuration outcome UNKNOWN. Recover the original command.");
    } finally {
      if (owner.current === token) {
        owner.current = null;
        setBusy(false);
      }
    }
  };
  const recover = async () => {
    const original = attemptRef.current;
    if (
      !original ||
      original.environmentId !== props.environmentId ||
      original.command.projectId !== props.projectId ||
      !session ||
      owner.current
    )
      return;
    const token = {};
    owner.current = token;
    const epoch = generation.current;
    setBusy(true);
    try {
      const result = await status({ environmentId: props.environmentId, input: original.command });
      if (generation.current !== epoch || attemptRef.current !== original) return;
      if (result._tag === "Success" && result.value === "committed") {
        sessionStorage.removeItem(key);
        attemptRef.current = null;
        setAttempt(null);
        setNotice(
          "Original configuration command is committed. Load configurations to select a revision. No command was resent.",
        );
      } else
        setNotice(
          "Original configuration outcome remains UNKNOWN, conflicting or unavailable. No replacement was sent.",
        );
    } finally {
      if (owner.current === token) {
        owner.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label="Saved task configurations">
      {notice ? <p role="status">{notice}</p> : null}
      {attempt ? (
        <>
          <p>
            Original configuration command: {attempt.command.commandId}. Environment:{" "}
            {attempt.environmentId}. Project: {attempt.command.projectId}.
          </p>
          <Button
            disabled={
              busy ||
              attempt.environmentId !== props.environmentId ||
              attempt.command.projectId !== props.projectId
            }
            onClick={() => void recover()}
          >
            Recover saved configuration
          </Button>
        </>
      ) : null}
      {props.open ? (
        <>
          <h4>Saved configurations</h4>
          <p>
            A saved configuration is reusable task input, not an independently online agent or
            permission.
          </p>
          <Button disabled={busy || !session} onClick={() => void load()}>
            Load saved configurations
          </Button>
          {[...latest.values()].map((profile) => (
            <div key={profile.id}>
              <p>
                {profile.displayName} · revision {profile.version} · {profile.status} ·{" "}
                {profile.taskConfiguration!.modelSelection.instanceId}/
                {profile.taskConfiguration!.modelSelection.model}
              </p>
              <Button
                disabled={
                  props.disabled ||
                  busy ||
                  !!attempt ||
                  profile.status !== "active" ||
                  profile.taskConfiguration!.modelSelection.instanceId !==
                    props.modelSelection?.instanceId
                }
                onClick={() => props.onSelect(configurationSnapshot(profile))}
              >
                Use saved configuration {profile.displayName} r{profile.version}
              </Button>
              <Button
                disabled={props.disabled || busy || !!attempt || profile.status !== "active"}
                onClick={() => {
                  setEditing(profile);
                  setName(profile.displayName);
                  setInstructions(profile.instructions);
                }}
              >
                Edit saved configuration {profile.displayName}
              </Button>
              <Button
                disabled={props.disabled || busy || !!attempt || profile.status !== "active"}
                onClick={() =>
                  void send({
                    type: "profile.archive",
                    projectId: ProjectId.make(props.projectId!),
                    commandId: `archive-${randomUUID()}`,
                    profileId: profile.id,
                    expectedVersion: profile.version,
                  })
                }
              >
                Archive saved configuration {profile.displayName}
              </Button>
              {profile.status === "archived" ? (
                <Button
                  disabled={props.disabled || busy || !!attempt}
                  onClick={() =>
                    void send({
                      type: "profile.restore",
                      projectId: ProjectId.make(props.projectId!),
                      commandId: `restore-${randomUUID()}`,
                      profileId: profile.id,
                      expectedVersion: profile.version,
                    })
                  }
                >
                  Restore saved configuration {profile.displayName}
                </Button>
              ) : null}
            </div>
          ))}
          <label>
            Configuration name
            <Input
              aria-label="Configuration name"
              value={name}
              maxLength={80}
              disabled={busy || !!attempt || props.disabled}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Working instructions
            <Textarea
              aria-label="Working instructions"
              value={instructions}
              maxLength={8000}
              disabled={busy || !!attempt || props.disabled}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <Button
            disabled={
              props.disabled ||
              busy ||
              !!attempt ||
              !!initial.error ||
              !name.trim() ||
              !instructions.trim() ||
              !props.modelSelection?.model ||
              !session
            }
            onClick={() => {
              if (!props.modelSelection || !props.environmentId || !props.projectId) return;
              void send({
                type: "profile.save",
                projectId: ProjectId.make(props.projectId),
                commandId: `configuration-${randomUUID()}`,
                expectedVersion: editing?.version ?? 0,
                draft: {
                  id: editing?.id ?? `configuration-${randomUUID()}`,
                  displayName: name.trim(),
                  instructions: instructions.trim(),
                  description: "Saved task configuration",
                  purpose: "Visible governed task input",
                  responsibilities: [],
                  exclusions: [],
                  requiredOutputSections: ["Result"],
                  artifactKind: "task-input",
                  capabilityPreferences: [],
                  taskConfiguration: {
                    environmentId: props.environmentId,
                    modelSelection: props.modelSelection,
                  },
                },
              });
            }}
          >
            {editing ? "Save configuration revision" : "Save new configuration"}
          </Button>
          {editing ? (
            <Button
              disabled={busy || !!attempt}
              onClick={() => {
                setEditing(null);
                setName("");
                setInstructions("");
              }}
            >
              New configuration draft
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
