import type { DateTime } from "effect";
import { type MachinesView, type Measured, type NamedMachine, type TaskLevels, unsetTaskLevels } from "@tui-dash/schema";
import { type Block, ellipsize, failureLines, gib, type Line, percent, sentence, span, type Span, type Tone } from "@tui-dash/ui";

export interface Machines {
  readonly names: ReadonlyArray<string>;
  readonly local: string;
}

// The compact line colours each number instead of drawing a bar, green while fine, yellow from 50 percent, red from 80.
const usageHealth = (percentUsed: number): Tone => {
  if (percentUsed < 50) return "success";
  if (percentUsed < 80) return "warning";
  return "error";
};

const reported = (measured: Measured): number | undefined => (measured.kind === "value" ? measured.value : undefined);

const metric = (text: string, percentUsed: number): Span => span(text, usageHealth(percentUsed));

const metricLine = (label: string, value: Span): Line => [span(`${label} `, "muted"), value];

const gap: Span = span("  ", "foreground");

const compactMetrics = (machine: Extract<NamedMachine["state"], { readonly kind: "ok" }>): Line => {
  const { cpu, memory, disk } = machine.view.machine;
  const gpu = machine.view.gpu;
  const cards = gpu?.kind === "ok" ? gpu.value.gpus.flatMap((card) => { const busy = reported(card.utilizationPercent); return busy === undefined ? [] : [busy]; }) : [];
  const parts: Array<Line> = [];
  if (cpu.kind === "ok") parts.push(metricLine("cpu", metric(percent(cpu.value.percent), cpu.value.percent)));
  if (memory.kind === "ok") {
    const share = (memory.value.usedBytes / memory.value.totalBytes) * 100;
    parts.push(metricLine("mem", metric(`${gib(memory.value.usedBytes)}/${gib(memory.value.totalBytes)}`, share)));
  }
  if (cards.length > 0) parts.push(metricLine("gpu", metric(percent(Math.max(...cards)), Math.max(...cards))));
  if (disk !== undefined && disk.kind === "ok") {
    const share = (disk.value.usedBytes / disk.value.totalBytes) * 100;
    parts.push(metricLine("disk", metric(percent(share), share)));
  }
  return parts.flatMap((part, index) => (index === 0 ? part : [gap, ...part]));
};

const machineHead = (machine: NamedMachine, width: number): { readonly head: Line; readonly tail: Block } => {
  const name = span(ellipsize(machine.name, width), "foreground", { bold: true });
  switch (machine.state.kind) {
    case "ok":
      return { head: [name, gap, ...compactMetrics(machine.state)], tail: [] };
    case "pending":
      return { head: [name, gap, span("reading…", "muted")], tail: [] };
    case "stale":
      return { head: [name, gap, span("out of date", "warning")], tail: [] };
    case "unreachable":
    case "invalid":
      // The tail is indented two spaces by its caller, so it wraps two narrower.
      return { head: [name], tail: failureLines(machine.state, width - 2) };
  }
};

// Each machine's line judges that machine's own tasks, from its own report, so a limit line never claims a check that ran elsewhere.
// Tasks kept from the samples alone were not checked now, so only a report and task usage read now earn the all clear.
const unflaggedLines = (levels: TaskLevels, width: number): Block => {
  if (levels.pending) return sentence("checking the tasks\u2026", "muted", width);
  if (levels.unset) return sentence("no tasks report, so no task is checked against the machine", "muted", width);
  if (levels.failures.some((failure) => failure.source === "tasks")) {
    return sentence("! tasks report not read, so no task is checked against the machine", "error", width);
  }
  if (!levels.usageRead && levels.source === "remote" && !levels.liveConfigured)
    return sentence("task usage not read: TUI_DASH_REMOTE_TASK_LIVE is unset", "muted", width);
  if (!levels.usageRead) return sentence("task usage not read", "muted", width);
  return [[span("\u2713 ", "success"), span(ellipsize("no task over its share", width - 2), "foreground")]];
};

const machineLimitLines = (levels: TaskLevels, width: number): Block => {
  const over = levels.projects.flatMap((project) =>
    project.tasks.flatMap((task) => task.episodes.filter((episode) => episode.ongoing).map((episode) => ({ task, limit: episode.limit }))),
  );
  if (over.length === 0) return unflaggedLines(levels, width);
  return over.map(({ task, limit }): Line => [
    span("\u2691 ", "error", { bold: true }),
    span(ellipsize(`${task.id} ${limit === "memory" ? "uses over a quarter of memory" : "uses over half the cores"}`, width - 2), "foreground", { bold: true }),
  ]);
};

// A machine with no entry, such as one with resources but no tasks command, reads as unset rather than borrowing another machine's levels.
const levelsForMachine = (
  levels: ReadonlyMap<string, TaskLevels>,
  local: string,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
  machine: string,
): TaskLevels | undefined =>
  levels.get(machine) ?? (machine === local ? levels.get(local) : unsetTaskLevels(machine, now, zone));

const resourceLines = (machine: NamedMachine, width: number): Block => {
  const { head, tail } = machineHead(machine, width);
  return [head, ...tail.map((line): Line => [span("  ", "foreground"), ...line])];
};

export const machinesBoxLines = (
  view: MachinesView,
  machines: Machines,
  levels: ReadonlyMap<string, TaskLevels>,
  zone: DateTime.TimeZone,
  width: number,
): Block => {
  const lines: Array<Line> = [];
  for (const [index, name] of machines.names.entries()) {
    if (index > 0) lines.push([]);
    const machine = view.machines.find((resource) => resource.name === name);
    if (machine === undefined) lines.push([span(ellipsize(name, width), "foreground", { bold: true })]);
    else lines.push(...resourceLines(machine, width));
    const judged = levelsForMachine(levels, machines.local, view.now, zone, name);
    if (judged !== undefined) lines.push(...machineLimitLines(judged, width - 2).map((line): Line => [span("  ", "foreground"), ...line]));
  }
  return lines;
};
