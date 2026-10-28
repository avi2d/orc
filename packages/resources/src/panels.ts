import type { DateTime } from "effect";
import type {
  Failed,
  GpuAppView,
  GpusView,
  GpuView,
  MachinesView,
  MachineView,
  Measured,
  NamedMachine,
  Outcome,
  ProcessView,
  ResourcesView,
} from "@tui-dash/schema";
import {
  type Block,
  countdown,
  ellipsize,
  failureLine,
  failureLines,
  gib,
  type Line,
  lineWidth,
  loadHealth,
  padEnd,
  padStart,
  panel,
  panelChrome,
  percent,
  secondsBetween,
  span,
  usedOfTotal,
  widthOf,
  withinRows,
  wrapParts,
} from "@tui-dash/ui";

const sharedFailure = (
  [first, ...rest]: readonly [Outcome<unknown>, ...ReadonlyArray<Outcome<unknown>>],
): Failed | undefined => {
  if (first.kind === "ok") return undefined;
  const text = JSON.stringify(first);
  return rest.every((outcome) => JSON.stringify(outcome) === text) ? first : undefined;
};

const statLine = (label: string, value: Line, width: number): Line => {
  const lead = `  \u00b7 ${label} `;
  return [span(widthOf(lead) + lineWidth(value) <= width ? lead : `${label} `, "subtle"), ...value];
};

const statOf = <A>(outcome: Outcome<A>, width: number, shown: (value: A) => Line): Line =>
  outcome.kind === "ok" ? shown(outcome.value) : failureLine(outcome, width);

const measuredText = (metric: Measured, shown: (value: number) => Line): Line =>
  metric.kind === "value" ? shown(metric.value) : [span("not reported", "muted")];

const temperatureText = (gpu: GpuView): Line =>
  measuredText(gpu.temperatureC, (celsius) => [span(`${Math.round(celsius)}C`, loadHealth(celsius))]);

const valueWidth = 10;

const meter = (label: string, text: string, share: number, width: number): Line => {
  const tone = loadHealth(share * 100);
  const value = Math.max(valueWidth, widthOf(text));
  const bar = Math.max(0, width - 6 - 1 - value);
  const filled = Math.min(bar, Math.max(0, Math.round(share * bar)));
  return [
    span(padEnd(label, 6), "subtle"),
    span("\u2588".repeat(filled), tone),
    span("\u2591".repeat(bar - filled), "muted"),
    span(` ${padStart(text, value)}`, tone),
  ];
};

const meterOf = <A>(
  label: string,
  outcome: Outcome<A>,
  width: number,
  reading: (value: A) => { readonly share: number; readonly text: string },
): Line => {
  if (outcome.kind !== "ok") return [span(padEnd(label, 6), "subtle"), ...failureLine(outcome, width - 6)];
  const { share, text } = reading(outcome.value);
  return meter(label, text, share, width);
};

const pidWidth = 8;
const programWidth = 15;
const cpuWidth = 5;
const memoryWidth = 6;

interface ProcessColumns {
  readonly program: number;
  readonly cpu: number;
}

// The program column gives way so a narrow panel keeps the pid, cpu and memory columns whole.
const processColumns = (shown: ReadonlyArray<ProcessView>, width: number): ProcessColumns => {
  const widest = (text: (process: ProcessView) => string, least: number) =>
    shown.reduce((most, process) => Math.max(most, widthOf(text(process))), least);
  const cpu = widest((process) => percent(process.cpuPercent), cpuWidth);
  const memory = widest((process) => gib(process.residentBytes), memoryWidth);
  const longest = widest((process) => process.program, 0);
  // Capped at the longest name so Cpu and Mem stay next to the names.
  const program = Math.min(Math.max(programWidth, longest + 1), width - 2 - pidWidth - cpu - 2 - memory);
  return { program, cpu };
};

const programHead = (program: number): string => `  ${padEnd("Pid", pidWidth)}${padEnd(ellipsize("Program", program - 1), program)}`;

const tableHead = ({ program, cpu }: ProcessColumns): Line => [
  span(`${programHead(program)}${padStart("Cpu", cpu)}  Mem`, "subtle"),
];

const processRow = (process: ProcessView, { program, cpu }: ProcessColumns): Line => [
  span(`  ${padEnd(String(process.pid), pidWidth)}`, "subtle"),
  span(padEnd(ellipsize(process.program, program - 1), program), "foreground"),
  span(padStart(percent(process.cpuPercent), cpu), loadHealth(process.cpuPercent)),
  span(`  ${gib(process.residentBytes)}`, "foreground"),
];

const moreLine = (hidden: number, what = ""): Block => (hidden > 0 ? [[span(`  +${hidden} more${what}`, "muted")]] : []);

const processTable = (processes: Outcome<ReadonlyArray<ProcessView>>, rows: number, width: number): Block => {
  if (processes.kind !== "ok") return failureLines(processes, width);
  const shown = processes.value.slice(0, rows);
  const hidden = processes.value.length - shown.length;
  const columns = processColumns(shown, width);
  return [
    ...(shown.length === 0 && hidden > 0 ? [] : [tableHead(columns)]),
    ...shown.map((process) => processRow(process, columns)),
    ...moreLine(hidden, shown.length === 0 ? " processes" : ""),
  ];
};

const loadLine = (machine: MachineView, width: number): Line =>
  statLine(
    "load",
    statOf(machine.load, width - 9, (load) => [span(load.map((average) => average.toFixed(2)).join(" "), "foreground")]),
    width,
  );

export const machinePanelLines = (machine: MachineView, rows: number, width: number): Block => {
  const everything = sharedFailure([machine.cpu, machine.memory, machine.load, machine.processes]);
  if (everything !== undefined) return failureLines(everything, width);
  const host = sharedFailure([machine.cpu, machine.memory, machine.load]);
  if (host !== undefined) {
    return [...failureLines(host, width), ...processTable(machine.processes, rows, width)];
  }
  return machineDetail(machine, rows, width);
};

const machineDetail = (machine: MachineView, rows: number, width: number): Block => [
  ...(machine.cpu.kind === "ok" ? [[span(`${machine.cpu.value.cores} cores`, "subtle")]] : []),
  meterOf("cpu", machine.cpu, width, (cpu) => ({ share: cpu.percent / 100, text: percent(cpu.percent) })),
  meterOf("mem", machine.memory, width, (memory) => ({
    share: memory.usedBytes / memory.totalBytes,
    text: usedOfTotal(memory.usedBytes, memory.totalBytes),
  })),
  ...processTable(machine.processes, rows, width),
  loadLine(machine, width),
];

const measuredMeter = (label: string, metric: Measured, width: number, text: (value: number) => string): Line =>
  metric.kind === "value"
    ? meterOf(label, { kind: "ok", value: metric.value }, width, (value) => ({ share: value / 100, text: text(value) }))
    : [span(padEnd(label, 6), "subtle"), span("not reported", "muted")];

const vramMeter = (gpu: GpuView, width: number): Line =>
  gpu.memoryUsedMiB.kind === "value" && gpu.memoryTotalMiB.kind === "value"
    ? meterOf(
        "vram",
        { kind: "ok", value: { used: gpu.memoryUsedMiB.value, total: gpu.memoryTotalMiB.value } },
        width,
        (vram) => ({
          share: vram.used / vram.total,
          text: usedOfTotal(vram.used * 1024 ** 2, vram.total * 1024 ** 2),
        }),
      )
    : [span(padEnd("vram", 6), "subtle"), span("not reported", "muted")];

const vramText = (app: GpuAppView): Line =>
  measuredText(app.memoryUsedMiB, (mib) => [span(`${Math.round(mib)}MiB`, "foreground")]);

const appRow = (app: GpuAppView, program: number): Line => [
  span(`  ${padEnd(String(app.pid), pidWidth)}`, "subtle"),
  span(
    padEnd(ellipsize(app.program ?? "unknown", program - 1), program),
    app.program === undefined ? "muted" : "foreground",
  ),
  ...vramText(app),
];

const appTable = (outcome: Outcome<ReadonlyArray<GpuAppView>>, width: number): Block => {
  if (outcome.kind !== "ok") return failureLines(outcome, width);
  const apps = outcome.value;
  if (apps.length === 0) return [[span("  no compute apps", "muted")]];
  const vram = Math.max(widthOf("VRAM"), ...apps.map((app) => lineWidth(vramText(app))));
  const program = Math.min(programWidth, width - 2 - pidWidth - vram);
  return [[span(`${programHead(program)}VRAM`, "subtle")], ...apps.map((app) => appRow(app, program))];
};

const shownProcesses = 8;

const gpuCard = (gpu: GpuView, width: number): Block => [
  [span(ellipsize(gpu.name, width), "subtle")],
  measuredMeter("gpu", gpu.utilizationPercent, width, percent),
  vramMeter(gpu, width),
  statLine("temp", temperatureText(gpu), width),
];

const gpuCards = (gpus: ReadonlyArray<GpuView>, width: number): Block =>
  gpus.length === 0 ? [[span("no gpu reported", "muted")]] : gpus.flatMap((gpu) => gpuCard(gpu, width));

export const gpuPanelLines = (gpus: Outcome<GpusView>, width: number): Block => {
  if (gpus.kind !== "ok") return failureLines(gpus, width);
  return [...gpuCards(gpus.value.gpus, width), ...appTable(gpus.value.apps, width)];
};

interface Titles {
  readonly machine: string;
  readonly gpu: string;
}

const viewPanels = (view: ResourcesView, titles: Titles, shown: number, width: number): Block => [
  ...panel(titles.machine, machinePanelLines(view.machine, shown, width - panelChrome), width),
  ...(view.gpu === undefined ? [] : panel(titles.gpu, gpuPanelLines(view.gpu, width - panelChrome), width)),
];

export const resourceLines = (view: ResourcesView, width: number): Block =>
  viewPanels(view, { machine: "machine", gpu: "gpu" }, shownProcesses, width);

const staleLines = (generatedAt: DateTime.Utc, now: DateTime.Utc, width: number): Block =>
  wrapParts(`! answered ${countdown(secondsBetween(generatedAt, now))} ago, so its readings are left out`.split(" "), width, " ").map(
    (text): Line => [span(text, "warning")],
  );

const titlesOf = (name: string, composed: boolean): Titles =>
  composed ? { machine: name, gpu: `${name} gpu` } : { machine: "machine", gpu: "gpu" };

const namedPanels = ({ name, state }: NamedMachine, composed: boolean, now: DateTime.Utc, shown: number, width: number): Block => {
  switch (state.kind) {
    case "ok":
      return viewPanels(state.view, titlesOf(name, composed), shown, width);
    case "pending":
      return panel(name, [[span("reading…", "muted")]], width);
    case "stale":
      return panel(name, staleLines(state.generatedAt, now, width - panelChrome), width);
    case "unreachable":
    case "invalid":
      return panel(name, failureLines(state, width - panelChrome), width);
  }
};

const fewerProcesses = Array.from({ length: shownProcesses + 1 }, (_, index) => shownProcesses - index);

// Every machine gives up process rows alike, so a short terminal never drops one machine's list for the other's.
export const machinesLines = (view: MachinesView, width: number, rows: number): Block => {
  const composed = view.machines.length > 1;
  const blocks = fewerProcesses.map((shown) =>
    view.machines.flatMap((machine) => namedPanels(machine, composed, view.now, shown, width)),
  );
  return blocks.find((block) => block.length <= rows) ?? withinRows(blocks.at(-1) ?? [], rows);
};
