import { Effect, Schema } from "effect"
import { runGit } from "../../shared/process/index"
import { OrcRunError } from "../../shared/lib/index"
import { readFailure } from "../../shared/config/index"
import type { HistoryRun } from "./run-record"

const PathRule = Schema.Struct({ path: Schema.String, instructions: Schema.String })
export type PathRule = typeof PathRule.Type

const ReviewConfig = Schema.Struct({
  review: Schema.optional(Schema.NullOr(Schema.Struct({
    path_instructions: Schema.optional(Schema.NullOr(Schema.Array(PathRule)))
  })))
})
const decodeReviewConfig = Schema.decodeUnknownEffect(ReviewConfig)

const configFile = ".no-mistakes.yaml"

export const readPathRules = (yamlText: string, source: string): Effect.Effect<ReadonlyArray<PathRule>, OrcRunError> =>
  Effect.gen(function*() {
    const parsed: unknown = yield* Effect.try({
      try: () => Bun.YAML.parse(yamlText),
      catch: () => new OrcRunError({ message: "orc: " + source + " is no YAML orc can read" })
    })
    const config = yield* decodeReviewConfig(parsed).pipe(
      Effect.mapError((error) => new OrcRunError({ message: "orc: " + source + " holds review.path_instructions orc cannot read: " + error.message }))
    )
    return config.review?.path_instructions ?? []
  })

export const rulesForChangedFiles = (rules: ReadonlyArray<PathRule>, changedFiles: ReadonlyArray<string>): ReadonlyArray<PathRule> =>
  rules.filter((rule) => {
    const glob = new Bun.Glob(rule.path)
    return changedFiles.some((file) => glob.match(file))
  })

export const pathRulesSection = (rules: ReadonlyArray<PathRule>): string =>
  rules.length === 0
    ? ""
    : [
      "",
      "The project's path rules follow, each for the changed files its glob matches.",
      "Apply each rule to those files, and name the rule's glob in the description of each finding it raises.",
      ...rules.flatMap((rule) => ["", "Rule for " + rule.path + ":", rule.instructions.trim()])
    ].join("\n")

const readChangedFiles = (
  run: Pick<HistoryRun, "spawner" | "git" | "projectDir" | "branch">
): Effect.Effect<ReadonlyArray<string>, OrcRunError> =>
  Effect.gen(function*() {
    const listed = yield* runGit(run.spawner, run.git, ["diff", "--name-only", "--no-renames", "HEAD..." + run.branch, "--"], run.projectDir)
    if (listed.exitCode !== 0) {
      return yield* new OrcRunError({ message: "orc cannot list the branch's changed files: " + listed.stderr.trim() })
    }
    return listed.stdout.split("\n").filter((line) => line.trim() !== "")
  })

export const projectPathRules = (
  run: Pick<HistoryRun, "fs" | "path" | "spawner" | "git" | "projectDir" | "worktreeDir" | "branch">
): Effect.Effect<ReadonlyArray<PathRule>, OrcRunError> =>
  Effect.gen(function*() {
    const text = yield* run.fs.readFileString(run.path.join(run.worktreeDir, configFile)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the review path rules in " + configFile + ": " + readFailure(cause) }))
    )
    const rules = yield* readPathRules(text, configFile)
    return rules.length === 0 ? [] : rulesForChangedFiles(rules, yield* readChangedFiles(run))
  })
