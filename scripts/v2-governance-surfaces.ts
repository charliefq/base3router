#!/usr/bin/env node
// Confirms the V1 UI Lab fixture app was not copied onto the V2 engine,
// and that Inspector and Control Center mount the governance projection.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const root = NodePath.resolve(import.meta.dirname, "..");
const absent = ["apps/web/src/lab/LabApp.tsx", "scripts/base3router-ui-lab.ts"];
for (const relative of absent) {
  if (NodeFS.existsSync(NodePath.join(root, relative))) {
    NodeProcess.stderr.write(`V1 UI Lab file is present on the V2 tree: ${relative}\n`);
    NodeProcess.exit(1);
  }
}
const mounted = [
  ["apps/web/src/components/settings/SettingsPanels.tsx", "GovernanceControlCenter"],
  ["apps/web/src/components/chat/V2ItemInspector.tsx", "GovernanceInspector"],
  ["apps/web/src/components/governance/GovernanceSurfaces.tsx", "data-governance-surface"],
] as const;
for (const [relative, needle] of mounted) {
  const text = NodeFS.readFileSync(NodePath.join(root, relative), "utf8");
  if (!text.includes(needle)) {
    NodeProcess.stderr.write(`${relative} does not mount ${needle}\n`);
    NodeProcess.exit(1);
  }
}
NodeProcess.stdout.write("V2 governance surfaces are mounted. V1 UI Lab was not revived.\n");
