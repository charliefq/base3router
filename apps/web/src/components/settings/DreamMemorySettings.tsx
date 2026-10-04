import {
  DEFAULT_DREAM_MEMORY_SETTINGS,
  MEMORY_KINDS,
  type MemoryCaptureMode,
  type MemoryKind,
  type MemoryRecordV0,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function DreamMemorySettings() {
  const settings = useScopedSettings((value) => value.dreamMemory);
  const updateSettings = useUpdateScopedSettings();
  const environment = usePrimaryEnvironment();
  const capability = environment?.serverConfig?.environment.capabilities.dreamMemory;
  const [clearConfirm, setClearConfirm] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [records, setRecords] = useState<ReadonlyArray<MemoryRecordV0>>([]);
  const [saveText, setSaveText] = useState("");
  const [saveKind, setSaveKind] = useState<MemoryKind>("explicit-user-preference");
  const [correction, setCorrection] = useState<Record<string, string>>({});
  const exportMemory = useAtomCommand(serverEnvironment.memoryExport, { reportFailure: true });
  const clearScope = useAtomCommand(serverEnvironment.memoryClearScope, { reportFailure: true });
  const listMemory = useAtomCommand(serverEnvironment.memoryList, { reportFailure: true });
  const saveMemory = useAtomCommand(serverEnvironment.memorySave, { reportFailure: true });
  const decideMemory = useAtomCommand(serverEnvironment.memoryDecide, { reportFailure: true });
  const correctMemory = useAtomCommand(serverEnvironment.memoryCorrect, { reportFailure: true });
  const deleteMemory = useAtomCommand(serverEnvironment.memoryDelete, { reportFailure: true });
  const environmentId = environment?.environmentId;

  const refresh = useCallback(() => {
    if (environmentId === undefined) return;
    void listMemory({ environmentId, input: {} }).then((result) => {
      if (result._tag !== "Success") return;
      setRecords(result.value.memories);
    });
  }, [environmentId, listMemory]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (capability === undefined) return null;

  const memory = settings ?? DEFAULT_DREAM_MEMORY_SETTINGS;

  return (
    <SettingsSection id="dream-memory" title="Dream Memory">
      <SettingsRow
        serverScoped
        settingKeys={["dreamMemory"]}
        {...searchableSetting("dream-memory")}
        description="Memory is reference data, never permission. Disabling stops automatic capture, Dream processing, and retrieval. Explicit save remains available. Deletion is always free."
        control={
          <p className="text-2xs text-muted-foreground" data-dream-memory-mode="">
            {capability.enabled ? capability.captureMode : "disabled"}
          </p>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["dreamMemory"]}
        title="Enable Dream Memory"
        description="When off, future turns do not retrieve memory and Dream does not run. You can still save a fact explicitly."
        control={
          <Switch
            checked={memory.enabled}
            onCheckedChange={(checked) =>
              updateSettings({
                dreamMemory: { ...memory, enabled: Boolean(checked) },
              })
            }
            aria-label="Enable Dream Memory"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["dreamMemory"]}
        title="Capture mode"
        description="Off: no Dream capture or retrieval. Review: proposals wait for approval. Automatic: only low-risk preferences and conventions may activate."
        control={
          <Select
            value={memory.captureMode}
            onValueChange={(value) => {
              const captureMode = value as MemoryCaptureMode;
              if (
                captureMode === "off" ||
                captureMode === "review" ||
                captureMode === "automatic"
              ) {
                updateSettings({ dreamMemory: { ...memory, captureMode } });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label="Dream Memory capture mode"
            >
              <SelectValue>
                {memory.captureMode === "off"
                  ? "Off"
                  : memory.captureMode === "automatic"
                    ? "Automatic"
                    : "Review"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="off">
                Off
              </SelectItem>
              <SelectItem hideIndicator value="review">
                Review
              </SelectItem>
              <SelectItem hideIndicator value="automatic">
                Automatic
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["dreamMemory"]}
        title="Remember this"
        description="Explicit save is always available, including when automatic Dream is off."
        control={
          <div className="flex w-full flex-col gap-2">
            <Input
              size="sm"
              value={saveText}
              onChange={(event) => setSaveText(event.target.value)}
              aria-label="Memory to save"
              placeholder="A preference or project fact"
            />
            <Select
              value={saveKind}
              onValueChange={(value) => {
                if ((MEMORY_KINDS as readonly string[]).includes(value)) {
                  setSaveKind(value as MemoryKind);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Memory kind">
                <SelectValue>{saveKind}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {MEMORY_KINDS.map((kind) => (
                  <SelectItem hideIndicator key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (environmentId === undefined || saveText.trim() === "") return;
                void saveMemory({
                  environmentId,
                  input: { content: saveText.trim(), kind: saveKind, scopeKind: "personal" },
                }).then((result) => {
                  if (result._tag !== "Success") return;
                  setSaveText("");
                  setStatus("Saved an explicit memory.");
                  refresh();
                });
              }}
            >
              Save memory
            </Button>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["dreamMemory"]}
        title="Memories"
        description="Inspect provenance, approve proposals, correct, or delete. Bodies are yours; Inspector traces show IDs only."
        control={
          <div className="flex w-full flex-col gap-2" data-memory-list="">
            {records.length === 0 ? (
              <p className="text-2xs text-muted-foreground">No memories in this scope.</p>
            ) : (
              records.map((record) => (
                <div key={record.memoryId} className="flex flex-col gap-1" data-memory-item="">
                  <p className="text-2xs">
                    {record.kind} · {record.status} · {record.confidence} · {record.freshness}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    {record.content ?? "(deleted)"} · expires {record.expiresAt ?? "until deleted"}
                    {record.supersedes !== undefined ? ` · supersedes ${record.supersedes}` : ""}
                    {record.contradicts !== undefined ? ` · contradicts ${record.contradicts}` : ""}
                  </p>
                  {record.status === "proposed" ? (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (environmentId === undefined) return;
                          void decideMemory({
                            environmentId,
                            input: { memoryId: record.memoryId, decision: "approve" },
                          }).then((result) => {
                            if (result._tag === "Success") refresh();
                          });
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (environmentId === undefined) return;
                          void decideMemory({
                            environmentId,
                            input: { memoryId: record.memoryId, decision: "reject" },
                          }).then((result) => {
                            if (result._tag === "Success") refresh();
                          });
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                  {record.status !== "deleted" ? (
                    <div className="flex flex-col gap-1">
                      <Input
                        size="sm"
                        value={correction[record.memoryId] ?? ""}
                        onChange={(event) =>
                          setCorrection((current) => ({
                            ...current,
                            [record.memoryId]: event.target.value,
                          }))
                        }
                        aria-label={`Correct ${record.memoryId}`}
                        placeholder="Replacement text"
                      />
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const content = correction[record.memoryId]?.trim();
                            if (
                              environmentId === undefined ||
                              content === undefined ||
                              content === ""
                            ) {
                              return;
                            }
                            void correctMemory({
                              environmentId,
                              input: { memoryId: record.memoryId, content },
                            }).then((result) => {
                              if (result._tag !== "Success") return;
                              setCorrection((current) => ({ ...current, [record.memoryId]: "" }));
                              refresh();
                            });
                          }}
                        >
                          Correct
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (environmentId === undefined) return;
                            void deleteMemory({
                              environmentId,
                              input: { memoryId: record.memoryId },
                            }).then((result) => {
                              if (result._tag === "Success") refresh();
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))
            )}
            <Button size="sm" variant="outline" onClick={refresh}>
              Refresh memories
            </Button>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["dreamMemory"]}
        title="Export and delete"
        description="Export is user-readable. Clear scope permanently removes retrievable content after confirmation."
        control={
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (environmentId === undefined) return;
                void exportMemory({
                  environmentId,
                  input: {},
                }).then((result) => {
                  if (result._tag !== "Success") return;
                  setStatus(`Exported ${result.value.recordCount} memories.`);
                });
              }}
            >
              Export memory
            </Button>
            {clearConfirm ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  if (environmentId === undefined) return;
                  void clearScope({
                    environmentId,
                    input: { scopeKind: "personal", confirm: true },
                  }).then((result) => {
                    if (result._tag !== "Success") return;
                    setClearConfirm(false);
                    setStatus(`Cleared ${result.value.clearedCount} memories.`);
                    refresh();
                  });
                }}
              >
                Confirm clear personal memory
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setClearConfirm(true)}>
                Clear personal memory
              </Button>
            )}
            {status ? (
              <p className="text-2xs text-muted-foreground" data-memory-status="">
                {status}
              </p>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}
