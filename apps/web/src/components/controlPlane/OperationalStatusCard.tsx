import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export type OperationalStatusTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASS: Record<OperationalStatusTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-[var(--control-plane-accent)]",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-error-foreground",
};

export function OperationalStatusCard(props: {
  readonly title: string;
  readonly value?: string | null;
  readonly detail?: string | null;
  readonly tone?: OperationalStatusTone;
  readonly children?: ReactNode;
}) {
  return (
    <section className="rounded-[var(--control-plane-card-radius)] border border-border/80 bg-card/40 px-3 py-2.5">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {props.title}
        </h3>
        {props.value ? (
          <p className={cn("text-2xs font-medium", TONE_CLASS[props.tone ?? "neutral"])}>
            {props.value}
          </p>
        ) : null}
      </header>
      {props.detail ? <p className="mt-1 text-sm text-foreground">{props.detail}</p> : null}
      {props.children}
    </section>
  );
}

export function statusTone(status: string | null | undefined): OperationalStatusTone {
  switch (status) {
    case "active":
    case "running":
    case "starting":
    case "ALLOW":
    case "completed":
    case "accepted":
      return "success";
    case "approval":
    case "paused":
    case "proposed":
    case "DENY":
      return "warning";
    case "failed":
    case "error":
    case "rejected":
    case "cancelled":
    case "unavailable":
      return "danger";
    default:
      return "neutral";
  }
}
