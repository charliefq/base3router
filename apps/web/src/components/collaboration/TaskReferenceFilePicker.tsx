import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useAtomValue } from "@effect/atom-react";
import { ChatAttachmentId, type ChatFileAttachment, type EnvironmentId } from "@t3tools/contracts";
import { isPlainReferenceText } from "@t3tools/shared/taskReferenceFile";
import { sha256Hex } from "@t3tools/shared/actionCanonical";
import { fileAttachmentCapabilityBlockReason } from "../chat/composerAttachmentFiles";
import { serverEnvironment } from "../../state/server";
import {
  startAttachmentUpload,
  releaseDraftAttachment,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import type { ComposerFileAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
export type TaskReferenceSelection =
  | { status: "pending" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; attachment: ChatFileAttachment; contentSha256: string };
export function TaskReferenceFilePicker(props: {
  environmentId: EnvironmentId;
  session: object | null;
  disabled: boolean;
  retain: MutableRefObject<boolean>;
  onChange: (value: TaskReferenceSelection | null) => void;
}) {
  const { environmentId, session, disabled, retain, onChange } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [file, setFile] = useState<ComposerFileAttachment | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef<ComposerFileAttachment | null>(null);
  const epoch = useRef(0);
  const upload = useAttachmentUploadStore((s) => (file ? s.uploadsByImageId[file.id] : undefined));
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const clear = useCallback(() => {
    epoch.current++;
    if (current.current && !retain.current) releaseDraftAttachment(current.current);
    current.current = null;
    setFile(null);
    setHash(null);
    setNotice(null);
    onChange(null);
  }, [retain, onChange]);
  useLayoutEffect(() => {
    epoch.current++;
    current.current = null;
    // Retire local upload state when its environment or authenticated session changes.
    // eslint-disable-next-line react/set-state-in-effect
    setFile(null);
    setHash(null);
    onChange(null);
    return () => {
      epoch.current++;
      if (current.current && !retain.current) releaseDraftAttachment(current.current);
    };
    // Scope changes deliberately revoke the prior session upload, even before another file is chosen.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [environmentId, session, retain, onChange]);
  useLayoutEffect(() => {
    // Availability changes revoke a staged upload before another review can use it.
    // eslint-disable-next-line react/set-state-in-effect
    if (disabled && !retain.current) clear();
  }, [disabled, retain, clear]);
  useEffect(() => {
    if (
      !disabled &&
      file &&
      current.current?.id === file.id &&
      hash &&
      upload?.status === "ready" &&
      upload.environmentId === environmentId
    )
      onChange({
        status: "ready",
        attachment: {
          type: "file",
          id: ChatAttachmentId.make(upload.attachmentId),
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        },
        contentSha256: hash,
      });
  }, [disabled, file, hash, upload, environmentId, onChange]);
  const choose = async (files: FileList | null) => {
    clear();
    setNotice(null);
    if (!files?.length) return;
    if (disabled || files.length !== 1) {
      setNotice("Choose exactly one reference file.");
      onChange({ status: "unavailable", reason: "Exactly one reference file required." });
      return;
    }
    const selected = files[0]!;
    const reason = fileAttachmentCapabilityBlockReason({
      attachmentUploadsCapabilityKnown: config !== null,
      supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
      maxFileAttachmentBytes:
        config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      files: [{ name: selected.name, sizeBytes: selected.size }],
    });
    if (
      reason ||
      !selected.size ||
      !/^[^/\\]+\.txt$/i.test(selected.name) ||
      (selected.type && selected.type !== "text/plain")
    ) {
      const problem = reason ?? "Only one ordinary UTF-8 text/plain .txt file is supported.";
      setNotice(problem);
      onChange({ status: "unavailable", reason: problem });
      return;
    }
    onChange({ status: "pending" });
    const generation = epoch.current;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await selected.arrayBuffer(),
      );
      if (!isPlainReferenceText(text)) throw new Error("Binary content is not supported.");
      if (
        generation !== epoch.current ||
        latest.current.disabled ||
        latest.current.environmentId !== environmentId ||
        latest.current.session !== session
      )
        return;
      const staged: ComposerFileAttachment = {
        type: "file",
        id: ChatAttachmentId.make(randomUUID()),
        name: selected.name,
        mimeType: "text/plain",
        sizeBytes: selected.size,
        file: selected,
      };
      current.current = staged;
      setFile(staged);
      setHash(sha256Hex(text));
      startAttachmentUpload({ environmentId: environmentId, image: staged });
    } catch {
      if (generation === epoch.current) {
        setNotice("Reference file could not be read as UTF-8 text.");
        onChange({ status: "unavailable", reason: "Reference file read failed." });
      }
    }
  };
  return (
    <section aria-label="Task reference file">
      <label>
        One plain-text reference file
        <input
          aria-label="Choose task reference file"
          type="file"
          accept=".txt,text/plain"
          disabled={disabled}
          onChange={(event) => {
            void choose(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <p>
        Uploading does not start the task. Reference files currently require Codex. Review the file
        and optional instruction skill together before Start.
      </p>
      {file ? (
        <p>
          {file.name} · text/plain · {file.sizeBytes} bytes · SHA256 {hash ?? "pending"} ·{" "}
          {upload?.status ?? "uploading"}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Button type="button" variant="outline" disabled={disabled} onClick={clear}>
        Remove reference file
      </Button>
    </section>
  );
}
