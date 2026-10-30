import type { DispatchView } from "@tui-dash/schema";
import { type Block, failureText, type Label, labelledReadings, leastLabelWidth, reading, span } from "@tui-dash/ui";

const labelOf = (text: string): Label => ({ text, width: leastLabelWidth });

const counted = (count: number, what: string): ReadonlyArray<string> => (count > 0 ? [count + " " + what] : []);

export const dispatchSection = (view: DispatchView, width: number): Block => {
  const label = labelOf("dispatch");
  if (view.pending) return labelledReadings(label, [reading("muted", "reading\u2026")], width);
  if (view.missing) return labelledReadings(label, [reading("muted", "no backlog")], width);
  if (view.machines.kind !== "ok") {
    return [[span("dispatch ", "foreground"), ...failureText(view.machines)]];
  }
  const machines = view.machines.value;
  const busy = machines.reduce((total, entry) => total + entry.busy, 0);
  const slots = machines.reduce((total, entry) => total + entry.slots, 0);
  const parts = [
    reading("foreground", busy + " of " + slots + " busy"),
    ...counted(view.runs.length, view.runs.length === 1 ? "run" : "runs").map((part) => reading("foreground", part)),
    ...counted(view.waiting.length, "waiting").map((part) => reading("warning", part)),
  ];
  return labelledReadings(label, parts, width);
};
