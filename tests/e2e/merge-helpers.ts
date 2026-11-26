import { expect } from "bun:test"
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { closeTask, type Fixture, orchestratorConfig, ranClosing, sessionFor, withFixture } from "./chat-helpers"

export const prUrl = "https://github.com/acme/orc/pull/8"
export const head = "0123456789abcdef0123456789abcdef01234567"

export interface Rollup {
  readonly __typename: "CheckRun" | "StatusContext"
  readonly [field: string]: string
}

export const passed = (name: string, startedAt = "2026-11-02T10:00:00Z"): Rollup => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", startedAt })

export const newHead = "fedcba9876543210fedcba9876543210fedcba98"
export const baseHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export const mergeBase = "cccccccccccccccccccccccccccccccccccccccc"
export const squashHead = "dddddddddddddddddddddddddddddddddddddddd"
export const ciRunUrl = "https://github.com/acme/orc/actions/runs/91"

interface ChangedFile {
  readonly filename: string
  readonly previous_filename?: string
}

interface HeadView {
  readonly head: string
  readonly checks: ReadonlyArray<Rollup>
}

export interface Forge {
  readonly state?: "OPEN" | "CLOSED" | "MERGED"
  readonly checks?: ReadonlyArray<Rollup>
  readonly behind?: number
  readonly files?: ReadonlyArray<string>
  readonly baseFiles?: ReadonlyArray<ChangedFile>
  readonly mergeRefusal?: string
  readonly update?: "updates" | "conflicts" | "head moved" | "reject duplicate"
  readonly afterUpdate?: ReadonlyArray<HeadView>
  readonly parents?: string
  readonly flakyViews?: number
  readonly flakyParents?: number
}

export const ghCalls = (fixture: Fixture): string => join(fixture.dir, "gh-calls")

export const stubRunner = async (fixture: Fixture): Promise<void> => {
  const runner = join(fixture.dir, "bin", "runner-stub")
  const document = JSON.stringify({ schema: "orc.runner.v1", result: { task: "orc-1", status: "unknown", run: { id: "origin-run", status: "succeeded", prLink: prUrl, endReason: null, openQuestions: [] } } })
  await writeFile(runner, "#!/bin/sh\ncat > /dev/null\necho '" + document + "'\n")
  await chmod(runner, 0o755)
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "mac", slots: 1, start: ["true", "runner", "start", "--", runner] }],
    quota: { provider: "acme", command: ["true"], accounts: [{ name: "main", tokenFile: "/x" }], floorPercent: 15 }
  }))
}

export const taskFile = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")

export const mergeCalls = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").filter((line) => line.startsWith("pr merge"))

export const foreignHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

export const red = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-02T10:05:00Z" })
export const running = (name: string): Rollup => ({ __typename: "CheckRun", workflowName: "ci", name, status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-02T10:05:00Z" })

export const updateCall = "api --hostname github.com -X PUT repos/acme/orc/pulls/8/update-branch -f expected_head_sha=" + head

export const forgeSteps = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(ghCalls(fixture), "utf8")).split("\n").flatMap((line) =>
    line.startsWith("pr view") ? ["view"] : line.includes("update-branch") ? ["update"] : line.startsWith("pr merge") ? [line] : [])

export const sentBackTask = (fixture: Fixture): Promise<string> => readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")

export const viewJson = (state: string, view: HeadView): string =>
  JSON.stringify({ state, headRefOid: view.head, baseRefName: "main", statusCheckRollup: view.checks })

const updateReply = (update: Forge["update"]): ReadonlyArray<string> => {
  switch (update) {
    case "conflicts": {
      return ["echo '{\"message\":\"merge conflict between base and head\"}'", "echo 'gh: merge conflict between base and head (HTTP 422)' >&2", "exit 1"]
    }
    case "head moved": {
      return ["echo '{\"message\":\"expected head sha did not match current head ref.\"}'", "echo 'gh: expected head sha did not match current head ref. (HTTP 422)' >&2", "exit 1"]
    }
    case "reject duplicate": {
      return [
        "if [ -f \"$VIEWS/updated\" ]; then echo 'gh: duplicate update request (HTTP 422)' >&2; exit 1; fi",
        ...updateReply("updates")
      ]
    }
    case "updates":
    case undefined: {
      return ["touch \"$VIEWS/updated\"", "echo '{\"message\":\"Updating pull request branch.\"}'", "exit 0"]
    }
  }
}

export const stubGh = async (fixture: Fixture, forge: Forge): Promise<void> => {
  const views = join(fixture.dir, "views")
  const state = forge.state ?? "OPEN"
  const after = forge.afterUpdate ?? [{ head: newHead, checks: [passed("lint"), passed("test")] }]
  await mkdir(views, { recursive: true })
  await writeFile(join(views, "before.json"), viewJson(state, { head, checks: forge.checks ?? [passed("lint"), passed("test")] }))
  await Promise.all(after.map((view, index) => writeFile(join(views, "after-" + String(index + 1) + ".json"), viewJson(state, view))))
  await writeFile(join(views, "after-last.json"), viewJson(state, after.at(-1) ?? { head: newHead, checks: [] }))
  await writeFile(join(views, "pr-comparison.json"), JSON.stringify({
    behind_by: forge.behind ?? 0,
    base_commit: { sha: baseHead },
    merge_base_commit: { sha: mergeBase },
    files: [{ filename: "shared.txt" }]
  }))
  await writeFile(join(views, "base-files.json"), JSON.stringify(forge.baseFiles ?? [{ filename: "shared.txt" }]))
  await writeFile(ghCalls(fixture), "")
  await writeFile(join(fixture.dir, "bin", "gh"), [
    "#!/bin/sh",
    "VIEWS='" + views + "'",
    "echo \"$*\" >> '" + ghCalls(fixture) + "'",
    "case \"$*\" in *update-branch*)",
    ...updateReply(forge.update),
    ";; esac",
    "if [ \"$1 $2\" = \"pr view\" ]; then",
    "  if [ ! -f \"$VIEWS/updated\" ]; then cat \"$VIEWS/before.json\"; exit 0; fi",
    "  f=$(( $(cat \"$VIEWS/flaky\" 2>/dev/null || echo 0) + 1 )); echo $f > \"$VIEWS/flaky\"",
    "  if [ \"$f\" -le " + String(forge.flakyViews ?? 0) + " ]; then echo 'gh: Internal Server Error (HTTP 500)' >&2; exit 1; fi",
    "  n=$(( $(cat \"$VIEWS/served\" 2>/dev/null || echo 0) + 1 )); echo $n > \"$VIEWS/served\"",
    "  if [ -f \"$VIEWS/after-$n.json\" ]; then cat \"$VIEWS/after-$n.json\"; else cat \"$VIEWS/after-last.json\"; fi",
    "  exit 0",
    "fi",
    "case \"$*\" in *'/files '*) cat <<'J'",
    ...(forge.files ?? ["shared.txt"]).map((path) => JSON.stringify({ status: "modified", path, patch: "+example" })),
    "J",
    "exit 0;; esac",
    "case \"$*\" in *compare/main..." + newHead + "*)",
    "  case \"$*\" in *.behind_by) echo 0;; *) echo '{\"behind_by\":0,\"base_commit\":{\"sha\":\"" + baseHead + "\"},\"merge_base_commit\":{\"sha\":\"" + baseHead + "\"},\"files\":[]}';; esac",
    "  exit 0;; esac",
    "case \"$*\" in *compare/main..." + head + "*) cat \"$VIEWS/pr-comparison.json\"; exit 0;; esac",
    "case \"$*\" in *compare/" + mergeBase + "..." + baseHead + "*) cat \"$VIEWS/base-files.json\"; exit 0;; esac",
    "case \"$*\" in *commits/*)",
    "  c=$(( $(cat \"$VIEWS/parents-flaky\" 2>/dev/null || echo 0) + 1 )); echo $c > \"$VIEWS/parents-flaky\"",
    "  if [ \"$c\" -le " + String(forge.flakyParents ?? 0) + " ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi",
    "  echo " + (forge.parents ?? head) + "; exit 0;; esac",
    "case \"$*\" in *graphql*) cat \"$VIEWS/base-runs.json\"; if [ -f \"$VIEWS/base-fails\" ]; then exit 1; fi; exit 0;; esac",
    "if [ \"$1\" = api ]; then echo 0; exit 0; fi",
    "if [ \"$1 $2\" = \"pr merge\" ]; then",
    ...(forge.mergeRefusal === undefined ? [] : [
      "  if [ ! -f \"$VIEWS/updated\" ]; then",
      "    echo " + JSON.stringify(forge.mergeRefusal) + " >&2; exit 1",
      "  fi"
    ]),
    "  exit 0",
    "fi",
    "echo 'unexpected gh call' >&2",
    "exit 1",
    ""
  ].join("\n"))
  await chmod(join(fixture.dir, "bin", "gh"), 0o755)
}

export const writeProject = (fixture: Fixture, extra: Record<string, unknown>): Promise<void> =>
  writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: fixture.dir }, ...extra }] }))

export const withMergeFixture = (body: (fixture: Fixture) => Promise<void>): Promise<void> =>
  withFixture(orchestratorConfig, 0, (fixture) => body({ ...fixture, env: { ...fixture.env, ORC_MERGE_POLL_SECONDS: "0.05" } }))

interface AddedBacklog {
  readonly folders: ReadonlyArray<string>
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
}

const backlogEntries = async (backlog: string) =>
  (await readdir(backlog, { recursive: true, withFileTypes: true })).map((entry) => ({ entry, path: relative(backlog, join(entry.parentPath, entry.name)) }))

let firstAdd: Promise<AddedBacklog> | undefined

const addTask = async (fixture: Fixture): Promise<AddedBacklog> => {
  const backlog = join(fixture.home, "backlog")
  const before = new Set((await backlogEntries(backlog)).map(({ path }) => path))
  expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
  const added = (await backlogEntries(backlog)).filter(({ path }) => !before.has(path))
  return {
    folders: added.filter(({ entry }) => entry.isDirectory()).map(({ path }) => path),
    files: await Promise.all(added.filter(({ entry }) => entry.isFile()).map(async ({ path }) => ({ path, text: await readFile(join(backlog, path), "utf8") })))
  }
}

const replayAdd = async (fixture: Fixture, added: AddedBacklog): Promise<void> => {
  const backlog = join(fixture.home, "backlog")
  await Promise.all(added.folders.map((folder) => mkdir(join(backlog, folder), { recursive: true })))
  await Promise.all(added.files.map((file) => writeFile(join(backlog, file.path), file.text)))
}

// A real add starts one orc process per test, so only the first fixture adds the task and the rest replay the folders and files it wrote.
export const closedWithPr = async (fixture: Fixture): Promise<void> => {
  if (firstAdd === undefined) {
    firstAdd = addTask(fixture)
    await firstAdd
  } else {
    await replayAdd(fixture, await firstAdd)
  }
  await closeTask(fixture, "orc-1", ranClosing("done", "", prUrl))
}
