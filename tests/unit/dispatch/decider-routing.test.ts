import { describe, expect, test } from "bun:test"
import { guardReason } from "../../../packages/run/src/features/decider/decider-guard"

describe("review routing boundaries", () => {
  for (const kind of ["worker-question", "review-question", "review-finding"] as const) {
    for (const asks of [undefined, "unknown", "none", "merge", "inspect"]) {
      test(kind + " with action " + String(asks) + " cannot receive an answer without words", () => {
        for (const text of ["", " \n\t"]) {
          expect(guardReason({ text, asks }, kind)).toContain("carries no words")
        }
      })
    }
  }

  for (const asks of [undefined, "unknown", "none"]) {
    test("a finding classified " + String(asks) + " does not escalate code descriptions as owner actions", () => {
      expect(guardReason({ text: "The merge record loses its access token when the task deletes a result.", asks }, "review-finding")).toBeNull()
    })
  }

  for (const asks of [undefined, "unknown"]) {
    test("an unclassified review question does not bypass the merge guard with action " + String(asks), () => {
      expect(guardReason({ text: "Merge this branch now?", asks }, "review-question")).toContain("about merging")
      expect(guardReason({ text: "How many retries?", asks }, "review-question")).toBeNull()
    })
  }

  for (const kind of ["review-question", "review-finding"] as const) {
    for (const asks of ["inspect", "go-public", "share"]) {
      test(kind + " does not treat unrecognized action " + asks + " as routine", () => {
        expect(guardReason({ text: "Choose the next step.", asks }, kind)).toContain("which orc does not know")
      })
    }

    for (const asks of ["merge", "delete", "login", "push", "release"]) {
      test(kind + " does not answer owner action " + asks + " even with routine text", () => {
        expect(guardReason({ text: "Choose the next step.", asks }, kind)).toContain("asks the owner to")
      })
    }

    test(kind + " with action none does not escalate a nonempty code question", () => {
      expect(guardReason({ text: "Should the report look at both retry counters?", asks: "none" }, kind)).toBeNull()
    })
  }

  test.each([
    "delete files outside the task",
    "delete file outside this task",
    "remove files outside the task",
    "Delete files outside task"
  ])("a worker request to %s still reaches the owner instead of the decider", (text) => {
    expect(guardReason({ text }, "worker-question")).toContain("about deleting")
  })

  test("a worker question does not bypass topic checks using a review action", () => {
    expect(guardReason({ text: "Merge this branch now?", asks: "none" }, "worker-question")).toContain("about merging")
  })
})
