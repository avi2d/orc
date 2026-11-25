import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { addTasks, beatTimeout, orcOk, quotaConfig, settledStarts, withFixture } from "./dispatch-helpers"

test("a beat starts each task with its own routed models and matching account, not the roomiest account for both", async () => {
  await withFixture({ mac: 2, linux: 0, floorPercent: 20 }, async (fixture) => {
    const start = ["sh", "-c", "printf '%s %s %s %s\\n' \"$ORC_TASK_ID\" \"$ORC_TASK_PROVIDER\" \"$ORC_TASK_ACCOUNT\" \"$ORC_TASK_ROUTED_MODELS\" >> \"$ROUTED_STARTS\""]
    const accounts = [
      { name: "main", tokenFile: "/secrets/main-token" },
      { name: "second", provider: "code", tokenFile: "/secrets/second-token", models: { implementer: "code/legacy", fixer: "code/legacy" } }
    ]
    const models = { implementer: "code/work", fixer: "code/fix", reviewer: "code/review" }
    await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: 2, start }],
      quota: { ...quotaConfig(20), accounts },
      routing: { rules: [{ when: { kind: "ship" }, candidates: [{ models }] }], default: ["acme/scout"] }
    }))
    await writeFile(join(fixture.dir, "home", "backlog", "projects.json"), JSON.stringify({
      projects: [{ name: "orc", checkouts: { mac: join(fixture.dir, "checkout") } }]
    }))
    await addTasks(fixture, 1)
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--kind", "scout", "--priority", "0"])
    const shown = await orcOk(fixture, ["beat"], { ROUTED_STARTS: fixture.startLog })
    expect(shown).toContain("dispatch rules pick an account for each task")
    expect(await settledStarts(fixture, 2)).toEqual([
      "orc-1 code second " + JSON.stringify(models),
      'orc-2 acme main {"implementer":"acme/scout"}'
    ])
  })
}, beatTimeout)
