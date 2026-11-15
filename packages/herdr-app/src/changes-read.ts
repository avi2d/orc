import { exec } from "herdr"
import type { Checkout } from "./agents"
import { type RunChanges, changedFiles } from "./changes"
import { type Reading, readText } from "./orc-read"

const folderExists = (folder: string): Promise<boolean> =>
  exec("test", ["-d", folder]).then((result) => result.code === 0, () => false)

const git = (worktree: string, args: ReadonlyArray<string>): Promise<Reading<string>> =>
  readText("git", ["-C", worktree, ...args])

const readFiles = (checkout: Checkout, base: string): Promise<Reading<RunChanges | null>> =>
  git(checkout.worktree, ["diff", "--numstat", "-z", "--no-renames", base, checkout.branch]).then((numstat): Reading<RunChanges | null> => {
    if (numstat.kind !== "ok") return numstat
    const files = changedFiles(numstat.value)
    if (files.kind === "refused") return { kind: "failed", reason: `git diff --numstat printed a list this view cannot read: ${files.reason}` }
    return { kind: "ok", value: files.value.length === 0 ? null : { ...checkout, base, files: files.value } }
  })

export const readChanges = (checkout: Checkout): Promise<Reading<RunChanges | null>> =>
  folderExists(checkout.worktree).then((exists): Promise<Reading<RunChanges | null>> | Reading<RunChanges | null> => {
    if (!exists) return { kind: "ok", value: null }
    return git(checkout.worktree, ["rev-parse", "--verify", checkout.branch]).then((rev) => {
      if (rev.kind !== "ok") return rev
      const commit = rev.value.trim()
      return git(checkout.worktree, ["merge-base", commit, "origin/HEAD"]).then((base) =>
        base.kind === "ok" ? readFiles({ worktree: checkout.worktree, branch: commit }, base.value.trim()) : base)
    })
  })

export const readDiff = (changes: Pick<RunChanges, "worktree" | "base" | "branch">, path: string): Promise<Reading<string>> =>
  git(changes.worktree, ["diff", "--literal-pathspecs", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", changes.base, changes.branch, "--", path])
