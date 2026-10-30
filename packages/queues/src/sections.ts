import { Option } from "effect";
import type { ActionsView, MachineQueue, PueueView, QueuesView } from "@tui-dash/schema";
import { type Block, failureText, type Label, labelledReadings, leastLabelWidth, machineLabel, reading, span } from "@tui-dash/ui";
import { repoName } from "./panels";

const labelOf = (text: string): Label => ({ text, width: leastLabelWidth });

const actionsLabel = labelOf("actions");

export const counted = (count: number, what: string): ReadonlyArray<string> => (count > 0 ? [`${count} ${what}`] : []);

const workParts = (pueue: PueueView): ReadonlyArray<string> => {
  const parts = [...counted(pueue.running.length, "running"), ...counted(pueue.queued, "queued")];
  return parts.length === 0 ? ["idle"] : parts;
};

const lastFailed = (pueue: PueueView): boolean => {
  const last = pueue.ended.at(0);
  return last !== undefined && last.result.kind !== "success";
};

const pueueReadings = (pueue: PueueView) => [
  ...workParts(pueue).map((part) => reading("foreground", part)),
  ...(pueue.paused > 0 ? [reading("warning", `${pueue.paused} paused`)] : []),
  ...pueue.groups.filter((group) => group.status === "Paused").map((group) => reading("warning", `${group.name} group paused`)),
  ...(lastFailed(pueue) ? [reading("error", "last run failed")] : []),
];

const stillReading = reading("muted", "reading…");

const machineLines = (machine: MachineQueue, label: Label, width: number): Block => {
  if (Option.isNone(machine.pueue)) return labelledReadings(label, [reading("foreground", machine.name), stillReading], width);
  const read = machine.pueue.value;
  return read.kind === "ok"
    ? labelledReadings(label, [reading("foreground", machine.name), ...pueueReadings(read.value)], width)
    : [[...machineLabel(label.text, label.width), span(`${machine.name} `, "foreground"), ...failureText(read)]];
};

const actionsLines = (actions: ActionsView, width: number): Block => {
  const repo = repoName(actions.repo);
  if (Option.isNone(actions.runs)) return labelledReadings(actionsLabel, [reading("foreground", repo), stillReading], width);
  const read = actions.runs.value;
  if (read.kind !== "ok") return [[...machineLabel(actionsLabel.text, actionsLabel.width), span(`${repo} `, "foreground"), ...failureText(read)]];
  const runs = read.value;
  const running = runs.filter((run) => run.running).length;
  const parts =
    runs.length === 0
      ? [reading("muted", "none queued")]
      : [...counted(running, "running"), ...counted(runs.length - running, "waiting")].map((part) => reading("foreground", part));
  return labelledReadings(actionsLabel, [reading("foreground", repo), ...parts], width);
};

export const queuesSection = (view: QueuesView, width: number): Block => [
  ...view.machines.flatMap((machine, index) => machineLines(machine, labelOf(index === 0 ? "queue" : ""), width)),
  ...actionsLines(view.actions, width),
];
