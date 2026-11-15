import { Data, DateTime, Effect, FileSystem, Option, type Path, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { bundledAgentsDir } from "../../entities/agent/index"
import { type AttentionItem, claimDeciding, closeItem, type OpenItem, openItems, recordDecision, reviewQuestionId, routeTaskItems, taskItems } from "../../entities/attention/index"
import { backlogPaths, findTask, type BacklogError, type ParkedQuestion, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { readInstructions, readOrcRules } from "../../entities/orc-rules/index"
import { answerTask } from "../../entities/parked-runs/index"
import { askBackWords, neverDecidedReason } from "./decider-guard"

export class DeciderUnheard extends Data.TaggedError("DeciderUnheard")<{
  readonly reason: string
}> {}

export interface DeciderRequest {
  readonly policy: string
  readonly prompt: string
}

export interface AskDecider {
  readonly home: string
  readonly ask: (request: DeciderRequest) => Effect.Effect<string, DeciderUnheard, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>
}

const Words = Schema.String.check(Schema.isNonEmpty())

const Reply = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("answer"), answer: Words, rule: Words, reason: Words }),
  Schema.Struct({ decision: Schema.Literal("ask-back"), question: Words }),
  Schema.Struct({ decision: Schema.Literal("duplicate"), of: Words }),
  Schema.Struct({ decision: Schema.Literal("escalate"), reason: Words })
])

type Reply = typeof Reply.Type

interface RuleSource {
  readonly source: string
  readonly text: string
}

interface WrittenRules extends RuleSource {
  readonly heading: string
}

type Basis = { readonly kind: "rule"; readonly quote: string; readonly source: string; readonly reason: string } | { readonly kind: "duplicate"; readonly of: string }

type Verdict =
  | { readonly kind: "answered"; readonly words: string; readonly basis: Basis }
  | { readonly kind: "asked-back"; readonly question: string }
  | { readonly kind: "escalated"; readonly reason: string }

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))

// A model may wrap its JSON in prose or a fence, so the object is cut out of the reply before it is read.
const readReply = (text: string): Reply | string => {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  return Option.getOrElse(decodeReply(json), () => "the decider's reply held no decision orc reads: " + text.trim().slice(0, 200))
}

const spaced = (text: string): string => text.replace(/\s+/g, " ").trim()

const unquoted = (quote: string): string => spaced(quote).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")

const sentencesAndLinesOf = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const line of text.split("\n")) {
    const trimmed = spaced(line)
    if (trimmed === "") {
      continue
    }
    const whole = unquoted(trimmed)
    if (whole !== "") {
      out.push(whole)
    }
    for (const part of trimmed.split(/(?<=[.!?])\s+/)) {
      const sentence = unquoted(part)
      if (sentence !== "" && sentence !== whole) {
        out.push(sentence)
      }
    }
  }
  return out
}

const quotedSource = (quote: string, sources: ReadonlyArray<RuleSource>): RuleSource | undefined => {
  const wanted = unquoted(quote)
  return wanted === "" ? undefined : sources.find((source) => sentencesAndLinesOf(source.text).includes(wanted))
}

interface Earlier {
  readonly id: string
  readonly text: string
  readonly answer: string
}

const answeredEarlier = (items: ReadonlyArray<OpenItem>, current: string): ReadonlyArray<Earlier> =>
  items.flatMap(({ id, item }) =>
    id !== current && (item.kind === "review-question" || item.kind === "worker-question") && item.state.kind === "closed"
      ? [{ id, text: item.text, answer: item.state.answer.words }]
      : [])

interface AskedBack {
  readonly id: string
  readonly text: string
  readonly question: string
}

const askedBackEarlier = (items: ReadonlyArray<OpenItem>, current: string): ReadonlyArray<AskedBack> =>
  items.flatMap(({ id, item }) =>
    id !== current && item.kind === "worker-question" && item.state.kind === "open" && item.decision?.kind === "asked-back"
      ? [{ id, text: item.text, question: item.decision.question }]
      : [])

const checkedVerdict = (reply: Reply, sources: ReadonlyArray<RuleSource>, earlier: ReadonlyArray<Earlier>, kind: AttentionItem["kind"]): Verdict => {
  switch (reply.decision) {
    case "escalate": {
      return { kind: "escalated", reason: reply.reason }
    }
    case "answer": {
      const found = quotedSource(reply.rule, sources)
      return found === undefined
        ? { kind: "escalated", reason: "the decider answered " + JSON.stringify(reply.answer) + " on a rule in none of the rules it read as a whole sentence or line: " + JSON.stringify(reply.rule) }
        : { kind: "answered", words: reply.answer.trim(), basis: { kind: "rule", quote: unquoted(reply.rule), source: found.source, reason: reply.reason } }
    }
    case "duplicate": {
      const linked = earlier.find((entry) => entry.id === reply.of.trim())
      return linked === undefined
        ? { kind: "escalated", reason: "the decider linked " + reply.of + ", which is no answered question of this task" }
        : { kind: "answered", words: linked.answer, basis: { kind: "duplicate", of: linked.id } }
    }
    case "ask-back": {
      return kind === "worker-question"
        ? { kind: "asked-back", question: reply.question.trim() }
        : { kind: "escalated", reason: "the decider asked back on a review question, and only a worker question is asked back: " + reply.question }
    }
  }
}

const deciderPolicyFile = (): string => bundledAgentsDir() + "/decider-policy.md"

const section = (heading: string, text: string): string => heading + ":\n\n" + text.trim()

const earlierSection = (earlier: ReadonlyArray<Earlier>): ReadonlyArray<string> =>
  earlier.length === 0
    ? []
    : [section("The questions of this task already answered, which a duplicate links by id", earlier.map((entry) => "- " + entry.id + ": " + spaced(entry.text) + "\n  answered: " + spaced(entry.answer)).join("\n"))]

// The question comes last, so nothing the prompt quotes after it reads as the question.
const askedBackSection = (askedBack: ReadonlyArray<AskedBack>): ReadonlyArray<string> =>
  askedBack.length === 0
    ? []
    : [section("The earlier worker questions the decider already asked back on, which the follow-up answers", askedBack.map((entry) => "- " + entry.id + ": " + spaced(entry.text) + "\n  decider asked back: " + spaced(entry.question)).join("\n"))]

const deciderPrompt = (task: TaskRecord, question: ParkedQuestion, kind: AttentionItem["kind"], rules: ReadonlyArray<WrittenRules>, earlier: ReadonlyArray<Earlier>, askedBack: ReadonlyArray<AskedBack>): string =>
  [
    ...rules.map((source) => section(source.heading, source.text)),
    section("The intent of the task " + task.spec.id + ", " + task.spec.title, task.spec.body),
    ...earlierSection(earlier),
    ...askedBackSection(askedBack),
    kind === "worker-question"
      ? section("The question the worker asked mid-run with orc_ask, " + question.id + ", which you may ask back", question.text)
      : section("The review question its run stopped on, " + question.id, question.text)
  ].join("\n\n")

export interface Decided {
  readonly item: string
  readonly task: string
  readonly verdict: Verdict
}

type Rules = { readonly kind: "read"; readonly written: ReadonlyArray<WrittenRules> } | { readonly kind: "unread"; readonly reason: string }

const readRules = (home: string, root: string, task: TaskRecord): Effect.Effect<Rules, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const orc = yield* readOrcRules(home)
    const instructions = yield* readInstructions(backlogPaths(root).projects, task.spec.project)
    const own: ReadonlyArray<WrittenRules> = orc.kind === "loaded" ? [{ source: orc.file, heading: "The owner's rules, from " + orc.file, text: orc.text }] : []
    const project = instructions
      .map((entry): WrittenRules => ({ source: entry.file, heading: "The instructions of the project " + entry.project + ", from " + entry.file, text: entry.text }))
    return { kind: "read" as const, written: [...own, ...project] }
  }).pipe(Effect.catchTag("RulesError", (error) => Effect.succeed({ kind: "unread" as const, reason: "orc cannot read the rules the decider reads: " + error.message })))

const askOne = (ask: AskDecider, policy: string, root: string, task: TaskRecord, question: ParkedQuestion, entry: OpenItem) =>
  Effect.gen(function*() {
    const rules = yield* readRules(ask.home, root, task)
    if (rules.kind === "unread") {
      return { kind: "escalated", reason: rules.reason } satisfies Verdict
    }
    const quotable: ReadonlyArray<RuleSource> = [...rules.written, { source: "decider policy", text: policy }, { source: "task " + task.spec.id, text: task.spec.body }]
    const items = yield* taskItems(root, task.spec.id)
    const earlier = answeredEarlier(items, entry.id)
    const askedBack = askedBackEarlier(items, entry.id)
    const prompt = deciderPrompt(task, question, entry.item.kind, rules.written, earlier, askedBack)
    return yield* ask.ask({ policy, prompt }).pipe(
      Effect.map((text): Verdict => {
        const reply = readReply(text)
        return typeof reply === "string" ? { kind: "escalated", reason: reply } : checkedVerdict(reply, quotable, earlier, entry.item.kind)
      }),
      Effect.catchTag("DeciderUnheard", (error) => Effect.succeed<Verdict>({ kind: "escalated", reason: "the decider was not heard: " + error.reason }))
    )
  })

const decisionOf = (verdict: Exclude<Verdict, { readonly kind: "escalated" }>, at: string) => {
  if (verdict.kind === "asked-back") {
    return { kind: "asked-back" as const, question: verdict.question, at }
  }
  const basis = verdict.basis
  return basis.kind === "duplicate"
    ? { kind: "duplicate" as const, of: basis.of, at }
    : { kind: "answered" as const, reason: basis.reason, rule: { quote: basis.quote, source: basis.source }, at }
}

const closeAskedBackEarlier = (root: string, taskId: string, current: string, at: string) =>
  Effect.gen(function*() {
    const fresh = yield* findTask(root, taskId)
    for (const entry of yield* taskItems(root, taskId)) {
      if (entry.id === current || entry.item.kind !== "worker-question" || entry.item.state.kind !== "open" || entry.item.decision?.kind !== "asked-back") {
        continue
      }
      const stored = fresh.parked?.questions.find((candidate) => reviewQuestionId(taskId, candidate.id, candidate.asked) === entry.id)?.answer
      yield* closeItem(root, entry.id, stored === null || stored === undefined ? { words: askBackWords(entry.item.decision.question), at } : { words: stored.words, at: stored.at }).pipe(Effect.catchTag("BacklogError", () => Effect.void))
    }
  })

const settle = (root: string, task: TaskRecord, question: ParkedQuestion, item: string, kind: AttentionItem["kind"], verdict: Verdict, at: string) =>
  Effect.gen(function*() {
    if (verdict.kind === "escalated") {
      yield* recordDecision(root, item, { kind: "escalated", reason: verdict.reason, at })
      if (kind === "worker-question") {
        yield* closeAskedBackEarlier(root, task.spec.id, item, at)
      }
      return verdict
    }
    yield* recordDecision(root, item, decisionOf(verdict, at))
    const words = verdict.kind === "asked-back" ? askBackWords(verdict.question) : verdict.words
    const by = verdict.kind === "asked-back" ? "asked-back" : "decider"
    const refused = yield* answerTask(root, task.spec.id, question.id + "=" + words, at, undefined, by).pipe(
      Effect.as(null),
      Effect.catchTags({ BacklogError: (error) => Effect.succeed(error.detail), TaskFileError: (error) => Effect.succeed(error.detail) })
    )
    if (refused === null) {
      yield* routeTaskItems(root, [yield* findTask(root, task.spec.id)], at)
      if (kind === "worker-question") {
        yield* closeAskedBackEarlier(root, task.spec.id, item, at)
      }
      return verdict
    }
    const fresh = yield* findTask(root, task.spec.id)
    const stored = fresh.parked?.questions.find((candidate) => candidate.id === question.id)?.answer
    if (stored !== null && stored !== undefined) {
      yield* routeTaskItems(root, [fresh], at)
      if (kind === "worker-question") {
        yield* closeAskedBackEarlier(root, task.spec.id, item, at)
      }
      return verdict
    }
    const escalated: Verdict = { kind: "escalated", reason: "the decider's answer did not reach the task: " + refused }
    yield* recordDecision(root, item, { kind: "escalated", reason: escalated.reason, at })
    return escalated
  })

interface Decidable {
  readonly entry: OpenItem
  readonly task: TaskRecord
  readonly question: ParkedQuestion
}

const decidableOf = (byId: ReadonlyMap<string, TaskRecord>, entry: OpenItem): Decidable | null => {
  if (entry.item.owner !== "decider") {
    return null
  }
  const task = byId.get(entry.item.task)
  if (task === undefined || task.state.kind === "closed") {
    return null
  }
  const question = task.parked?.questions.find((candidate) => reviewQuestionId(task.spec.id, candidate.id, candidate.asked) === entry.id)
  return question === undefined || question.answer !== null ? null : { entry, task, question }
}

// The guard runs before the policy is read, so no policy or rule can hand the decider a question on the list.
const verdictOf = (ask: AskDecider, policy: Effect.Effect<string>, root: string, { entry, task, question }: Decidable) =>
  Effect.gen(function*() {
    const guarded = neverDecidedReason(question.text)
    if (guarded !== null) {
      return { kind: "escalated", reason: guarded } satisfies Verdict
    }
    const read = yield* policy
    return read === ""
      ? { kind: "escalated", reason: "orc cannot read the decider policy at " + deciderPolicyFile() } satisfies Verdict
      : yield* askOne(ask, read, root, task, question, entry)
  })

// Each open question the decider owns gets its own call, so one question's reply never answers another.
export const decideReviewQuestions = (
  root: string,
  tasks: ReadonlyArray<TaskRecord>,
  ask: AskDecider
): Effect.Effect<ReadonlyArray<Decided>, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const policy = yield* Effect.cached(fs.readFileString(deciderPolicyFile()).pipe(Effect.orElseSucceed(() => "")))
    const decided: Array<Decided> = []
    const byId = new Map(tasks.map((task) => [task.spec.id, task] as const))
    for (const entry of yield* openItems(root)) {
      const decidable = decidableOf(byId, entry)
      if (decidable === null || !(yield* claimDeciding(root, entry.id, DateTime.formatIso(yield* DateTime.now)))) {
        continue
      }
      const verdict = yield* verdictOf(ask, policy, root, decidable)
      decided.push({ item: entry.id, task: decidable.task.spec.id, verdict: yield* settle(root, decidable.task, decidable.question, entry.id, decidable.entry.item.kind, verdict, DateTime.formatIso(yield* DateTime.now)) })
    }
    return decided
  })
