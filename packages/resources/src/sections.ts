import type { DateTime } from "effect";
import type { GpusView, GpuView, MachinesView, MachineView, Measured, NamedMachine, ResourcesView } from "@tui-dash/schema";
import {
  type Block,
  countdown,
  ellipsize,
  failureRows,
  gib,
  type Label,
  labelled,
  labelledReadings,
  leastLabelWidth,
  type Line,
  loadHealth,
  percent,
  reading,
  secondsBetween,
  span,
  widthOf,
  wrapParts,
} from "@tui-dash/ui";

const leastReadingWidth = 21;

const machineLines = (machine: MachineView, label: Label, width: number): Block => {
  const { cpu, memory } = machine;
  if (cpu.kind !== "ok" && memory.kind !== "ok") return failureRows(label, cpu, width);
  const cpuPart = cpu.kind === "ok" ? reading(loadHealth(cpu.value.percent), `cpu ${percent(cpu.value.percent)}`) : reading("muted", "cpu unknown");
  const memoryPart =
    memory.kind === "ok"
      ? reading(
          loadHealth((memory.value.usedBytes / memory.value.totalBytes) * 100),
          `memory ${gib(memory.value.usedBytes)}`,
          `of ${gib(memory.value.totalBytes)}`,
        )
      : reading("muted", "memory unknown");
  return labelledReadings(label, [cpuPart, memoryPart], width);
};

const mebibyte = 1024 * 1024;

const reported = (measured: Measured): number | undefined => (measured.kind === "value" ? measured.value : undefined);

// One card that does not report leaves any figure over all the cards unknown.
const everyCard = (gpus: ReadonlyArray<GpuView>, pick: (gpu: GpuView) => Measured): ReadonlyArray<number> | undefined => {
  const values = gpus.flatMap((gpu) => {
    const value = reported(pick(gpu));
    return value === undefined ? [] : [value];
  });
  return values.length === gpus.length ? values : undefined;
};

const sum = (values: ReadonlyArray<number> | undefined): number | undefined => values?.reduce((total, value) => total + value, 0);

const gpuReadings = (
  label: Label,
  title: string,
  busy: { readonly prefix: string; readonly percent: number | undefined },
  usedMiB: number | undefined,
  totalMiB: number | undefined,
  width: number,
): Block =>
  labelledReadings(
    label,
    [
      reading("foreground", title),
      ...(busy.percent === undefined ? [] : [reading(loadHealth(busy.percent), `${busy.prefix}${percent(busy.percent)}`)]),
      ...(usedMiB === undefined || totalMiB === undefined
        ? []
        : [reading("muted", `memory ${gib(usedMiB * mebibyte)}`, `of ${gib(totalMiB * mebibyte)}`)]),
    ],
    width,
  );

const gpuLines = (gpus: GpusView, labelWidth: number, width: number): Block => {
  if (gpus.gpus.length <= 2) {
    return gpus.gpus.flatMap((gpu) =>
      gpuReadings(
        { text: "gpu", width: labelWidth },
        gpu.name,
        { prefix: "", percent: reported(gpu.utilizationPercent) },
        reported(gpu.memoryUsedMiB),
        reported(gpu.memoryTotalMiB),
        width,
      ),
    );
  }
  const busy = everyCard(gpus.gpus, (gpu) => gpu.utilizationPercent);
  return gpuReadings(
    { text: "gpus", width: labelWidth },
    `${gpus.gpus.length} cards`,
    { prefix: "busiest ", percent: busy === undefined ? undefined : Math.max(...busy) },
    sum(everyCard(gpus.gpus, (gpu) => gpu.memoryUsedMiB)),
    sum(everyCard(gpus.gpus, (gpu) => gpu.memoryTotalMiB)),
    width,
  );
};

const viewLines = (view: ResourcesView, label: Label, width: number): Block => {
  const gpu = view.gpu;
  const machine = machineLines(view.machine, label, width);
  if (gpu === undefined) return machine;
  return [
    ...machine,
    ...(gpu.kind === "ok" ? gpuLines(gpu.value, label.width, width) : failureRows({ text: "gpu", width: label.width }, gpu, width)),
  ];
};

const staleRows = (generatedAt: DateTime.Utc, now: DateTime.Utc, label: Label, width: number): Block =>
  labelled(
    label,
    wrapParts(`! answered ${countdown(secondsBetween(generatedAt, now))} ago, so its readings are left out`.split(" "), width - label.width, " ").map(
      (text): Line => [span(text, "warning")],
    ),
  );

const namedLines = ({ state }: NamedMachine, label: Label, now: DateTime.Utc, width: number): Block => {
  switch (state.kind) {
    case "ok":
      return viewLines(state.view, label, width);
    case "pending":
      return labelledReadings(label, [reading("muted", "reading…")], width);
    case "stale":
      return staleRows(state.generatedAt, now, label, width);
    case "unreachable":
    case "invalid":
      return failureRows(label, state, width);
  }
};

export const resourcesSection = (view: MachinesView, width: number): Block => {
  const textOf = ({ name }: NamedMachine): string => (view.machines.length > 1 ? name : "machine");
  const widest = Math.max(leastLabelWidth, ...view.machines.map((machine) => widthOf(textOf(machine)) + 1));
  const labelWidth = Math.min(widest, Math.max(leastLabelWidth, width - leastReadingWidth));
  return view.machines.flatMap((machine) =>
    namedLines(machine, { text: ellipsize(textOf(machine), labelWidth - 1), width: labelWidth }, view.now, width),
  );
};
