import type { DispatchView } from "@tui-dash/schema";
import { type Block, type Label, labelledReadings, leastLabelWidth, reading } from "@tui-dash/ui";

const labelOf = (text: string): Label => ({ text, width: leastLabelWidth });

const counted = (count: number, what: string): ReadonlyArray<string> => (count > 0 ? [count + " " + what] : []);

export const dispatchSection = (view: DispatchView, width: number): Block => {
  const label = labelOf("dispatch");
  if (view.missing) return labelledReadings(label, [reading("muted", "no backlog")], width);
  if (view.machines.kind !== "ok") {
    return labelledReadings(
      label,
      [
        ...counted(view.runs.length, view.runs.length === 1 ? "run" : "runs").map((part) => reading("foreground", part)),
        ...counted(view.waiting.length, "waiting").map((part) => reading("warning", part)),
        ...counted(view.unread.length, "unread").map((part) => reading("warning", part)),
      ],
      width,
    );
  }
  const machines = view.machines.value;
  const busy = machines.reduce((total, entry) => total + entry.busy, 0);
  const slots = machines.reduce((total, entry) => total + entry.slots, 0);
  const parts = [
    reading("foreground", busy + " of " + slots + " busy"),
    ...counted(view.runs.length, view.runs.length === 1 ? "run" : "runs").map((part) => reading("foreground", part)),
    ...counted(view.waiting.length, "waiting").map((part) => reading("warning", part)),
    ...counted(view.unread.length, "unread").map((part) => reading("warning", part)),
  ];
  return labelledReadings(label, parts, width);
};
