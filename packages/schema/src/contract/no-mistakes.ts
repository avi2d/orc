import { decoded, type Decoded } from "../decode";

interface ActiveStep {
  readonly seconds: number | undefined;
  readonly round: string | undefined;
}

export interface NoMistakesStep {
  readonly step: string;
  readonly status: string;
  readonly findings: number;
  readonly durationMs: number;
  // An open step's duration counts only its finished rounds, so its time so far is the active row's.
  readonly active: ActiveStep | undefined;
}

export interface NoMistakesRun {
  readonly id: string;
  readonly branch: string;
  readonly status: string;
  readonly head: string;
  readonly pr: string;
  readonly outcome: string | undefined;
  readonly findings: string | undefined;
  readonly reviewer: string | undefined;
  readonly parkedSeconds: number | undefined;
  readonly steps: ReadonlyArray<NoMistakesStep>;
}

export type NoMistakesSnapshot = ReadonlyArray<NoMistakesRun>;

// Runs print as comma rows under a runs[N]{...} header, and one run's detail prints as key: value lines
// with its own steps table, so the scan below keeps one table and one detail run at a time.
const csvRowOf = (line: string): ReadonlyArray<string> => {
  const fields: Array<string> = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quoted) {
      if (char === "\"") {
        if (line[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields.map((entry) => entry.trim());
};

const headerOf = (line: string): { readonly name: string; readonly fields: ReadonlyArray<string> } | undefined => {
  const match = /^([a-z_]+)\[(\d+)\]\{([^}]*)\}:$/u.exec(line);
  if (match === null) return undefined;
  return { name: match[1], fields: match[3].split(",").map((field) => field.trim()).filter((field) => field !== "") };
};

const unquoted = (value: string): string =>
  value.startsWith("\"") && value.endsWith("\"") && value.length >= 2 ? value.slice(1, -1).replaceAll("\"\"", "\"") : value;

const scalarOf = (line: string): { readonly key: string; readonly value: string } | undefined => {
  const match = /^([a-z_]+):\s*(.*)$/u.exec(line);
  if (match === null) return undefined;
  return { key: match[1], value: unquoted(match[2].trim()) };
};

interface RawRun {
  id: string | undefined;
  branch: string | undefined;
  status: string | undefined;
  head: string | undefined;
  pr: string | undefined;
  outcome: string | undefined;
  findings: string | undefined;
  reviewer: string | undefined;
  parkedSeconds: number | undefined;
  steps: Array<NoMistakesStep> | undefined;
  active: Map<string, ActiveStep>;
}

interface Scan {
  readonly runs: Map<string, RawRun>;
  columns: ReadonlyArray<string> | undefined;
  rows: Array<ReadonlyArray<string>>;
  intoSteps: RawRun | undefined;
  intoActive: RawRun | undefined;
  detail: RawRun | undefined;
}

const scanOf = (): Scan => ({ runs: new Map(), columns: undefined, rows: [], intoSteps: undefined, intoActive: undefined, detail: undefined });

const keyed = (scan: Scan, id: string): RawRun => {
  const found = scan.runs.get(id);
  if (found !== undefined) return found;
  const fresh: RawRun = {
    id,
    branch: undefined,
    status: undefined,
    head: undefined,
    pr: undefined,
    outcome: undefined,
    findings: undefined,
    reviewer: undefined,
    parkedSeconds: undefined,
    steps: undefined,
    active: new Map(),
  };
  scan.runs.set(id, fresh);
  return fresh;
};

const numberedOf = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const stepRecordOf = (fields: ReadonlyArray<string>, values: ReadonlyArray<string>): NoMistakesStep => {
  const record = Object.fromEntries(fields.map((field, index) => [field, unquoted(values[index] ?? "")]));
  const asString = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    step: asString(record["step"]),
    status: asString(record["status"]),
    findings: numberedOf(asString(record["findings"])),
    durationMs: numberedOf(asString(record["duration_ms"])),
    active: undefined,
  };
};

const secondsOfSpan = (value: string): number | undefined => {
  const units: Readonly<Record<string, number>> = { d: 86400, h: 3600, m: 60, s: 1 };
  const parts = [...value.matchAll(/(\d+)\s*([dhms])/gu)];
  return parts.length === 0 ? undefined : parts.reduce((total, part) => total + Number.parseInt(part[1], 10) * (units[part[2]] ?? 0), 0);
};

const activeRecordOf = (fields: ReadonlyArray<string>, values: ReadonlyArray<string>): readonly [string, ActiveStep] => {
  const record = new Map(fields.map((field, index) => [field, unquoted(values[index] ?? "")]));
  const round = record.get("round");
  return [record.get("step") ?? "", { seconds: secondsOfSpan(record.get("active_for") ?? ""), round: round === "" ? undefined : round }];
};

const overviewRecordOf = (fields: ReadonlyArray<string>, values: ReadonlyArray<string>): Partial<RawRun> => {
  const record = Object.fromEntries(fields.map((field, index) => [field, unquoted(values[index] ?? "")]));
  const kept = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
  return {
    id: kept(record["id"]),
    branch: kept(record["branch"]),
    status: kept(record["status"]),
    head: kept(record["head"]),
    pr: kept(record["pr"]),
  };
};

const flushTable = (scan: Scan): void => {
  if (scan.intoSteps !== undefined && scan.columns !== undefined) {
    const target = scan.detail ?? scan.intoSteps;
    target.steps = scan.rows.map((row) => stepRecordOf(scan.columns ?? [], row));
  } else if (scan.intoActive !== undefined && scan.columns !== undefined) {
    for (const row of scan.rows) {
      const [step, active] = activeRecordOf(scan.columns, row);
      scan.intoActive.active.set(step, active);
    }
  } else if (scan.columns !== undefined) {
    for (const row of scan.rows) {
      const record = overviewRecordOf(scan.columns, row);
      if (record.id !== undefined) Object.assign(keyed(scan, record.id), record);
    }
  }
  scan.columns = undefined;
  scan.rows = [];
  scan.intoSteps = undefined;
  scan.intoActive = undefined;
};

const readHeader = (scan: Scan, header: { readonly name: string; readonly fields: ReadonlyArray<string> }): void => {
  flushTable(scan);
  if (header.name === "steps" && scan.detail !== undefined) {
    scan.columns = header.fields;
    scan.intoSteps = scan.detail;
  } else if (header.name === "active_steps" && scan.detail !== undefined) {
    scan.columns = header.fields;
    scan.intoActive = scan.detail;
  } else if (header.name === "runs") {
    scan.columns = header.fields;
  }
};

const readScalar = (scan: Scan, scalar: { readonly key: string; readonly value: string }): void => {
  if (scalar.key === "id") {
    scan.detail = keyed(scan, scalar.value);
    scan.detail.id = scalar.value;
    return;
  }
  if (scan.detail === undefined) return;
  const detail = scan.detail;
  if (scalar.key === "branch") detail.branch = scalar.value;
  else if (scalar.key === "status") detail.status = scalar.value;
  else if (scalar.key === "head") detail.head = scalar.value;
  else if (scalar.key === "head_sha") detail.head = detail.head ?? scalar.value;
  else if (scalar.key === "pr") detail.pr = scalar.value;
  else if (scalar.key === "outcome") detail.outcome = scalar.value;
  else if (scalar.key === "findings") detail.findings = scalar.value;
  else if (scalar.key === "reviewer_agent") detail.reviewer = scalar.value;
  else if (scalar.key === "awaiting_agent") {
    const parked = /^parked\s+(.+)$/iu.exec(scalar.value.trim());
    detail.parkedSeconds = parked === null ? undefined : secondsOfSpan(parked[1]);
  }
};

const snapshotOf = (scan: Scan): NoMistakesSnapshot => {
  const snapshot: Array<NoMistakesRun> = [];
  for (const raw of scan.runs.values()) {
    if (raw.id === undefined) continue;
    snapshot.push({
      id: raw.id,
      branch: raw.branch ?? "",
      status: raw.status ?? "",
      head: raw.head ?? "",
      pr: raw.pr ?? "",
      outcome: raw.outcome,
      findings: raw.findings,
      reviewer: raw.reviewer,
      parkedSeconds: raw.parkedSeconds,
      steps: (raw.steps ?? []).map((step) => ({ ...step, active: raw.active.get(step.step) })),
    });
  }
  return snapshot;
};

const readRow = (scan: Scan, trimmed: string): boolean => {
  if (scan.columns === undefined) return false;
  const values = trimmed === "" ? [] : csvRowOf(trimmed);
  if (values.length === scan.columns.length && values.some((value) => value !== "")) {
    scan.rows.push(values);
    return true;
  }
  flushTable(scan);
  return false;
};

export const decodeNoMistakes = (text: string): Decoded<NoMistakesSnapshot> => {
  const scan = scanOf();
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    const header = headerOf(trimmed);
    if (header !== undefined) {
      readHeader(scan, header);
      continue;
    }
    if (readRow(scan, trimmed)) continue;
    const scalar = scalarOf(trimmed);
    if (scalar !== undefined) {
      readScalar(scan, scalar);
      continue;
    }
    if (trimmed !== "" && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      flushTable(scan);
      if (trimmed.endsWith(":")) scan.detail = undefined;
    }
  }
  flushTable(scan);
  return decoded(snapshotOf(scan));
};
