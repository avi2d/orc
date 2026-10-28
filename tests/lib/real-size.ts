import type { Command } from "@tui-dash/schema";
import { recordedAnswer, tasksCommand } from "./dashboard-sources";
import { fixture } from "./fixtures";

const busyPueue = {
  tasks: 600,
  groups: 5,
  envKeysPerTask: 75,
  envValueLength: 96,
  distinctPaths: 108,
  runCopyPaths: 45,
  commandLength: 198,
  failed: 117,
  killed: 10,
} as const;

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

interface Recorded {
  readonly tasks: ReadonlyArray<Fields>;
  readonly groups: Fields;
  readonly done: Fields;
}

const recordedStatus = (): Recorded => {
  const parsed: unknown = JSON.parse(fixture("pueue/status.json"));
  if (!isFields(parsed) || !isFields(parsed["tasks"]) || !isFields(parsed["groups"])) throw new Error("pueue/status.json is not a pueue status");
  const tasks = Object.values(parsed["tasks"]).filter(isFields);
  const done = tasks.map((task) => (isFields(task["status"]) ? task["status"]["Done"] : undefined)).find(isFields);
  if (done === undefined) throw new Error("pueue/status.json holds no finished task");
  return { tasks, groups: parsed["groups"], done };
};

const resultOf = (index: number): unknown => {
  if (index % Math.round(busyPueue.tasks / busyPueue.killed) === 0) return "Killed";
  return index % Math.round(busyPueue.tasks / busyPueue.failed) === 0 ? { Failed: 1 } : "Success";
};

const pathOf = (index: number): string => {
  const distinct = index % busyPueue.distinctPaths;
  return distinct < busyPueue.runCopyPaths
    ? `/home/example/.no-mistakes/worktrees/${distinct.toString(16).padStart(12, "0")}/01EXAMPLERUN${distinct}`
    : `/home/example/projects/p${distinct}`;
};

const envsOf = (index: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: busyPueue.envKeysPerTask }, (_, key) => [`EXAMPLE_VAR_${key}`, `value-${index}-${key}-`.padEnd(busyPueue.envValueLength, "x")]),
  );

const taskAt = (recorded: Recorded, index: number): Fields => {
  const kept = recorded.tasks.at(index);
  const template = kept ?? recorded.tasks.at(0) ?? {};
  const command = `${String(template["command"])} # example-${index}`.padEnd(busyPueue.commandLength, "x");
  const status = kept === undefined ? { Done: { ...recorded.done, result: resultOf(index) } } : kept["status"];
  return { ...template, id: index, command, original_command: command, path: pathOf(index), envs: envsOf(index), status };
};

const realSizeStatus = (): string => {
  const recorded = recordedStatus();
  const tasks = Object.fromEntries(Array.from({ length: busyPueue.tasks }, (_, index) => [String(index), taskAt(recorded, index)]));
  const group = Object.values(recorded.groups)[0];
  const groups = Object.fromEntries(Array.from({ length: busyPueue.groups }, (_, index) => [Object.keys(recorded.groups)[index] ?? `group-${index}`, group]));
  return JSON.stringify({ tasks, groups });
};

let generated: string | undefined;

const realSizePueueStatus = (): string => {
  generated ??= realSizeStatus();
  return generated;
};

// Prefixes are tried in order, so a run's detail is matched before the overview that shares its start.
const realSizeAnswers: ReadonlyArray<readonly [string, () => string]> = [
  ["pueue status", realSizePueueStatus],
  [`sh -c ${tasksCommand}`, () => fixture("tasks/pipeline.json")],
  ["no-mistakes axi status --run ", () => fixture("no-mistakes/run.txt")],
  ["no-mistakes axi status", () => fixture("no-mistakes/overview.txt")],
  ["orc runs --json", () => fixture("orc/runs.json")],
  ["orc show ", () => fixture("orc/show.json")],
];

export const realSizeAnswer = (command: Command): string => {
  const line = command.argv.join(" ");
  return realSizeAnswers.find(([asked]) => line.startsWith(asked))?.[1]() ?? recordedAnswer(command);
};
