import { Context, Duration, Layer, Schema } from "effect";
import { type Decoded, decodeJson, decodeValue, flatMapDecoded } from "../decode";
import { runDecoded, sourceOf, stamped, type Source } from "../source";
import { nonEmptyLines, splitEach } from "./lines";
import { CountText } from "./numerals";

const HerdrPane = Schema.Struct({
  pane_id: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  agent_status: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  agent_session: Schema.optionalKey(Schema.NullOr(Schema.Struct({ kind: Schema.String, value: Schema.String }))),
});

const HerdrAgentList = Schema.Struct({ result: Schema.Struct({ agents: Schema.Array(HerdrPane) }) });

export type HerdrPane = typeof HerdrPane.Type;

export const decodeHerdrPanes = (stdout: string): Decoded<ReadonlyArray<HerdrPane>> =>
  flatMapDecoded(decodeJson(HerdrAgentList)(stdout), (list) => ({ kind: "ok", value: list.result.agents }));

const harnessPrograms = ["pi", "claude", "codex"] as const;

const HarnessProcess = Schema.Struct({
  pid: CountText,
  parent: CountText,
  program: Schema.Literals(harnessPrograms),
  cwd: Schema.String,
});

export type HarnessProcess = typeof HarnessProcess.Type;

const HarnessProcesses = Schema.Array(HarnessProcess);

const linuxRow = /^(\S+) (\S+) (\S+) (.+)$/;

export const decodeLinuxHarnessProcesses = (stdout: string): Decoded<ReadonlyArray<HarnessProcess>> =>
  flatMapDecoded(
    splitEach(nonEmptyLines(stdout), "pid, parent pid, program and working directory", (line) => {
      const match = linuxRow.exec(line);
      return match === null ? undefined : { pid: match[1], parent: match[2], program: match[3], cwd: match[4] };
    }),
    decodeValue(HarnessProcesses),
  );

// lsof -F prints one field per line, each process opening with its p line, and -c matches a prefix, so pip passes as pi.
export const decodeMacHarnessProcesses = (stdout: string): Decoded<ReadonlyArray<HarnessProcess>> => {
  const processes: Array<Record<string, string>> = [];
  for (const line of nonEmptyLines(stdout)) {
    const [field, value] = [line.slice(0, 1), line.slice(1)];
    if (field === "p") processes.push({ pid: value });
    const current = processes.at(-1);
    if (current === undefined) continue;
    if (field === "R") current["parent"] = value;
    if (field === "c") current["program"] = value;
    if (field === "n") current["cwd"] = value;
  }
  const shown = new Set<string>(harnessPrograms);
  return decodeValue(HarnessProcesses)(processes.filter((process) => shown.has(process["program"] ?? "")));
};

const herdrCommand = {
  argv: ["herdr", "agent", "list"],
  timeout: Duration.seconds(5),
} as const;

const linuxHarnessCommand = {
  argv: [
    "sh",
    "-c",
    'for d in /proc/[0-9]*; do IFS= read -r c 2>/dev/null < "$d/comm" || continue; case "$c" in pi|claude|codex) w=$(readlink "$d/cwd" 2>/dev/null) || continue; IFS= read -r s 2>/dev/null < "$d/stat" || continue; s=${s##*) }; set -- $s; printf "%s %s %s %s\\n" "${d#/proc/}" "$2" "$c" "$w";; esac; done',
  ],
  timeout: Duration.seconds(10),
} as const;

const macHarnessCommand = {
  argv: ["lsof", "-a", "-d", "cwd", "-c", "pi", "-c", "claude", "-c", "codex", "-R", "-F", "pRcn"],
  // lsof exits 1 when no process matches.
  exitCodes: [0, 1],
  timeout: Duration.seconds(10),
} as const;

export class HerdrSource extends Context.Service<HerdrSource, Source<ReadonlyArray<HerdrPane>>>()("tui-dash/HerdrSource") {}

export class HarnessProcessSource extends Context.Service<HarnessProcessSource, Source<ReadonlyArray<HarnessProcess>>>()(
  "tui-dash/HarnessProcessSource",
) {}

export const herdrSourceLayer = Layer.effect(HerdrSource, sourceOf(stamped(runDecoded(herdrCommand, decodeHerdrPanes))));

export const linuxHarnessProcessSourceLayer = Layer.effect(
  HarnessProcessSource,
  sourceOf(stamped(runDecoded(linuxHarnessCommand, decodeLinuxHarnessProcesses))),
);

export const macHarnessProcessSourceLayer = Layer.effect(
  HarnessProcessSource,
  sourceOf(stamped(runDecoded(macHarnessCommand, decodeMacHarnessProcesses))),
);
