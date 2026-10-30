import { DateTime } from "effect";
import {
  anchorOf,
  cueMarkOf,
  detailWithoutWaitsOf,
  gateHoldOf,
  isLive,
  markGlyphOf,
  modelBadgeOf,
  type PlannedRow,
  type ShownState,
  type StageMark,
  type TaskPipeline,
  type TaskRow,
  type TaskSpend,
  waitsOnOf,
} from "@tui-dash/schema";
import { type Block, clock, cycleName, ellipsize, type Line, lineWidth, plain, span, tintOfProvider, type Tone, truncate, widthOf, wrapParts } from "@tui-dash/ui";
import { descriptionLinesOf, episodeLines, keptLineOf, ratioText, stateTones, tokensText, type TaskOrigin } from "./levels";
import { activityOf, currentOf, lasted, markToneOf } from "./pipeline";

type Effort = "S" | "M" | "L";

export const effortOf = (tokens: number | undefined): Effort | undefined => {
  if (tokens === undefined) return undefined;
  if (tokens < 8000) return "S";
  if (tokens < 30000) return "M";
  return "L";
};

export const tintOfModel = (model: string | undefined): Tone => {
  if (model === undefined) return "muted";
  if (/opencode/iu.test(model)) return "opencodeGo";
  if (/codex/iu.test(model)) return "codex";
  if (/opus|sonnet|haiku|muse|claude/iu.test(model)) return "claude";
  return "muted";
};

const tintOfSpend = (spend: TaskSpend): Tone => spend.provider === undefined ? tintOfModel(spend.model) : tintOfProvider(spend.provider);

const stateMarkOf = (state: ShownState): StageMark => {
  switch (state) {
    case "waiting": return "waiting";
    case "done": return "done";
    case "unknown": return "unknown";
    case "working":
    case "parked":
    case "blocked": return cueMarkOf(state);
  }
};

const statusTextOf = (task: TaskRow): string => {
  switch (task.state) {
    case "waiting": {
      const waits = task.detail === undefined ? undefined : waitsOnOf(task.detail);
      return waits === undefined ? "waiting" : `waiting on ${waits}`;
    }
    case "working": return "working";
    case "parked": return "parked";
    case "blocked": return "blocked";
    case "done": return "done";
    case "unknown": return "no longer listed";
  }
};

const metaPartsOf = (task: TaskRow, origin: TaskOrigin, now: DateTime.Utc, zone: DateTime.TimeZone): ReadonlyArray<string> => {
  const started = `started ${clock(task.firstStartedAt, now, zone)}`;
  const lane = origin.machine;
  if (task.state === "done") {
    const ended = task.endedAt === undefined ? undefined : `ended ${clock(task.endedAt, now, zone)}`;
    return [started, ended, `ran ${lasted(task.seconds)}`, lane].filter((part): part is string => part !== undefined);
  }
  if (task.state === "unknown") {
    const seen = task.endedAt === undefined ? undefined : `last seen ${clock(task.endedAt, now, zone)}`;
    return [started, seen, `ran ${lasted(task.seconds)}`, lane].filter((part): part is string => part !== undefined);
  }
  const gate = gateHoldOf(task.pipeline);
  if (gate !== undefined) {
    const verb = task.state === "working" ? "running for" : `${task.state} for`;
    return gate.seconds === undefined ? [started, lane] : [started, `${verb} ${lasted(gate.seconds)}`, lane];
  }
  const verb = task.state === "working" ? "running for" : `${task.state} for`;
  return [started, `${verb} ${lasted(task.seconds)}`, lane];
};

const dotWidth = 2;

const modelLinesOf = (task: TaskRow, width: number): Block => {
  const spend = task.spend;
  if (spend === undefined) return [[span("no model recorded", "muted")]];
  const badge = modelBadgeOf(spend.model) ?? "unnamed model";
  const effort = effortOf(spend.outputTokens);
  const budget = Math.max(1, width - dotWidth);
  const flagged = spend.fair?.flagged === true;
  const current = flagged && isLive(task.state);
  const full = spend.fair === undefined ? undefined : `${cycleName(spend.fair)} ${spend.fair.account} ${ratioText(spend.fair.ratio)}${flagged ? " \u2691" : ""}`;
  const fair = full !== undefined && widthOf(full) > budget && spend.fair !== undefined
    ? `${ratioText(spend.fair.ratio)}${flagged ? " \u2691" : ""}`
    : full;
  const lead = [badge, effort, `${tokensText(spend.tokens)} tok`].filter((part): part is string => part !== undefined).join(" ");
  const words = [lead, fair].filter((part): part is string => part !== undefined);
  const tone = current ? "error" : "foreground";
  const wrapped = wrapParts(words, budget, " \u00B7 ");
  return wrapped.map((text, index): Line => [
    span(index === 0 ? "\u25CF " : " ".repeat(dotWidth), tintOfSpend(spend)),
    span(ellipsize(text, Math.max(0, width - dotWidth)), tone, current ? { bold: true } : {}),
  ]);
};

const pillTextOf = (name: string, glyph: string): string => `[${glyph} ${name}]`;

export const pillLines = (pipeline: TaskPipeline, width: number): Block => {
  const pills = pipeline.stages.map((stage) => ({ text: pillTextOf(stage.name, markGlyphOf(stage.mark)), tone: markToneOf(stage.mark) }));
  const lines: Array<Line> = [];
  let current: Line = [];
  for (const pill of pills) {
    const text = ellipsize(pill.text, width);
    const next: Line = [...current, ...(current.length === 0 ? [] : [span(" ", "foreground")]), span(text, pill.tone)];
    if (lineWidth(next) > width && current.length > 0) {
      lines.push(current);
      current = [span(text, pill.tone)];
    } else {
      current = next;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
};

const wordsOf = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[\s\u00B7]+/u).filter((word) => word !== "");

const unsaidDetailOf = (detail: string | undefined, shown: Block): string | undefined => {
  const said = new Set(wordsOf(shown.map(plain).join(" ")));
  const parts = (detail ?? "").split(" \u00B7 ").filter((part) => !wordsOf(part.replace(/^waits on /u, "")).every((word) => said.has(word)));
  return parts.length === 0 ? undefined : parts.join(" \u00B7 ");
};

const stageDetailOf = (task: TaskRow, pipeline: TaskPipeline, shown: Block, width: number, now: DateTime.Utc): Block => {
  const anchor = anchorOf(pipeline.stages);
  const pills = pillLines(pipeline, width);
  if (anchor === undefined) {
    const finished = pipeline.stages.length > 0 && pipeline.stages.every((stage) => stage.mark === "done");
    return [...pills, [span(ellipsize(finished ? "done" : "no pipeline recorded", width), finished ? "success" : "muted")]];
  }
  const unsaid = { ...anchor, detail: unsaidDetailOf(anchor.detail, shown) };
  const activity = activityOf(task, anchor, now);
  return [...pills, ...currentOf(task, pipeline, unsaid, now, width), ...(activity === "" ? [] : [[span(ellipsize(activity, width), "muted")]])];
};

const headerOf = (task: TaskRow, width: number): Line => {
  const kind = task.pipeline?.kind ?? task.kind;
  const kindRoom = width - widthOf(task.id) - 3;
  const kindText = kind === undefined || kindRoom < 2 ? "" : ellipsize(kind, kindRoom);
  const id = span(ellipsize(task.id, kindText === "" ? width : Math.max(0, width - widthOf(kindText) - 3)), "foreground", { bold: true });
  return truncate(kindText === "" ? [id] : [id, span(` \u00B7 ${kindText}`, "subtle")], width);
};

const statusLinesOf = (task: TaskRow, width: number): Block => {
  const gate = gateHoldOf(task.pipeline);
  if (gate !== undefined)
    return [truncate([span(`${markGlyphOf(gate.mark)} waiting for a decision`, markToneOf(gate.mark), { bold: true })], width)];
  const glyph = markGlyphOf(stateMarkOf(task.state));
  const tone = stateTones[task.state];
  if (task.state !== "waiting") return [truncate([span(`${glyph} ${statusTextOf(task)}`, tone, { bold: true })], width)];
  const wrapped = wrapParts(statusTextOf(task).split(" "), Math.max(1, width - dotWidth), " ");
  return wrapped.map((text, index): Line => [
    span(index === 0 ? `${glyph} ` : " ".repeat(dotWidth), tone, { bold: true }),
    span(ellipsize(text, Math.max(0, width - dotWidth)), tone, { bold: true }),
  ]);
};

const ordinalOf = (place: number): string => {
  const tens = place % 100;
  if (tens >= 11 && tens <= 13) return `${place}th`;
  return `${place}${["th", "st", "nd", "rd"][place % 10] ?? "th"}`;
};

const daySeconds = 86_400;

const queuedWords = (queuedOn: DateTime.Utc | undefined, now: DateTime.Utc): string | undefined => {
  if (queuedOn === undefined) return undefined;
  const days = Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(queuedOn)) / 1000 / daySeconds);
  return days <= 0 ? "queued today" : `queued ${days}d ago`;
};

const holdWords = (row: PlannedRow): string => {
  if (row.hold?.kind === "owner") return "held for you";
  if (row.hold?.kind === "external") return "held on an outside wait";
  if (row.hold?.kind === "unstated") return "held";
  return `held until ${row.after.join(", ")} ${row.after.length === 1 ? "is" : "are"} done`;
};

const sentence = (text: string, width: number, tone: Tone, limit: number): Block => {
  const room = Math.max(1, width - dotWidth);
  const parts = wrapParts(text.split(" "), room, " ");
  const kept = parts.slice(0, limit);
  const cut = parts.length > limit;
  return kept.map((part, index): Line => {
    const last = cut && index === kept.length - 1;
    return [span(" ".repeat(dotWidth), tone), span(last ? ellipsize(`${part}\u2026`, room) : ellipsize(part, room), tone)];
  });
};

const plannedStatusOf = (row: PlannedRow, width: number): Block => {
  if (row.next !== undefined) {
    const place = row.next === 1 ? "starts next" : `${ordinalOf(row.next)} in line`;
    return [truncate([span(`\u25C7 planned \u00B7 ${place}`, stateTones.planned, { bold: true })], width)];
  }
  const status = wrapParts(holdWords(row).split(" "), Math.max(1, width - dotWidth), " ").map((text, index): Line => [
    span(index === 0 ? "\u2298 " : " ".repeat(dotWidth), stateTones.held, { bold: true }),
    span(ellipsize(text, Math.max(0, width - dotWidth)), stateTones.held, { bold: true }),
  ]);
  const reason = row.hold === undefined || row.hold.reason.trim() === "" ? [] : sentence(row.hold.reason, width, "subtle", 4);
  const then = row.hold !== undefined && row.after.length > 0 ? sentence(`and after ${row.after.join(", ")}`, width, "subtle", 2) : [];
  return [...status, ...reason, ...then];
};

export const plannedTicketLines = (row: PlannedRow, now: DateTime.Utc, width: number): Block => {
  const kindText = ellipsize(row.kind, Math.max(0, width - row.id.length - 3));
  const header = truncate([span(ellipsize(row.id, Math.max(0, width - kindText.length - 3)), "foreground", { bold: true }), span(` \u00B7 ${kindText}`, "subtle")], width);
  const title = wrapParts(row.title.split(" "), width, " ").slice(0, 2).map((text): Line => [span(ellipsize(text, width), "foreground")]);
  const parts = [queuedWords(row.queuedOn, now), `${row.home} backlog`].filter((part): part is string => part !== undefined);
  const meta = wrapParts(parts, width).map((text): Line => [span(ellipsize(text, width), "muted")]);
  return [header, ...title, ...plannedStatusOf(row, width), ...meta];
};

export const ticketLines = (task: TaskRow, origin: TaskOrigin, now: DateTime.Utc, zone: DateTime.TimeZone, width: number): Block => {
  const meta = wrapParts(metaPartsOf(task, origin, now, zone), width).map((text): Line => [span(ellipsize(text, width), "muted")]);
  const title = wrapParts(task.title.split(" "), width, " ").slice(0, 2).map((text): Line => [span(ellipsize(text, width), "foreground")]);
  const gate = gateHoldOf(task.pipeline);
  const workerDetail = task.state === "waiting" && task.detail !== undefined ? detailWithoutWaitsOf(task.detail) : task.detail;
  const rest = gate === undefined ? workerDetail : undefined;
  const description = descriptionLinesOf(rest, width);
  const status = statusLinesOf(task, width);
  const pipeline = task.pipeline === undefined ? [] : stageDetailOf(task, task.pipeline, [...description, ...status], width, now);
  return [headerOf(task, width), ...title, ...description, ...status, ...meta, ...modelLinesOf(task, width), keptLineOf(task, width), ...pipeline, ...episodeLines(task, now, zone, width)];
};
