import { describe, expect, test } from "bun:test"
import { taskWait } from "../../packages/run/src/widgets/beat/beat-place"
import type { TaskRecord } from "../../packages/run/src/entities/backlog/index"

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

describe("a split sibling wait", () => {
  const parent: TaskRecord = {
    spec: { ...spec, id: "orc-1", kind: "parent", parent: null, dependsOn: [], split: { by: "intake", reason: "two slices" } },
    hold: null,
    parked: null,
    state: { kind: "new" }
  }
  const earlier: TaskRecord = {
    spec: { ...spec, id: "orc-2", title: "Record the split", parent: "orc-1", dependsOn: [] },
    hold: null,
    parked: null,
    state: {
      kind: "closed",
      claim,
      closing: { outcome: "done", started: { at: "2026-10-27T10:02:00.000Z", log: "/logs/orc-2.log" }, reason: "the run opened a PR", pr: "https://example.test/orc/pull/2", report: null },
      closedAt: "2026-10-27T11:00:00.000Z",
      postedAt: null
    }
  }
  const later: TaskRecord = {
    spec: { ...spec, id: "orc-4", title: "Plan at intake", parent: "orc-1", dependsOn: ["orc-2"] },
    hold: null,
    parked: null,
    state: { kind: "new" }
  }
  const tasks = [parent, earlier, later]
  test("a later slice waits for its sibling PR to merge instead of starting on a main without it", () => {
    expect(taskWait(later, tasks, new Set(), () => false)).toBe("waits on orc-2")
    expect(taskWait(later, tasks, new Set(["orc-2"]), () => false)).toBeNull()
  })
  test("an unrelated ship task waits for its dependency PR to merge instead of starting on done", () => {
    const other: TaskRecord = {
      spec: { ...spec, id: "orc-9", title: "Unrelated", parent: null, dependsOn: ["orc-2"] },
      hold: null,
      parked: null,
      state: { kind: "new" }
    }
    expect(taskWait(other, [...tasks, other], new Set(), () => false)).toBe("waits on orc-2")
    expect(taskWait(other, [...tasks, other], new Set(["orc-2"]), () => false)).toBeNull()
  })
  test("an unrelated scout task starts once its ship dependency closes done instead of waiting for the merge", () => {
    const scout: TaskRecord = {
      spec: { ...spec, id: "orc-9", title: "Unrelated", kind: "scout", parent: null, dependsOn: ["orc-2"] },
      hold: null,
      parked: null,
      state: { kind: "new" }
    }
    expect(taskWait(scout, [...tasks, scout], new Set(), () => false)).toBeNull()
  })
})
