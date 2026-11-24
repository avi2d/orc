import { Console, Effect } from "effect"
import { backlogPaths, backlogRoot } from "../entities/backlog/index"
import { readDispatchConfig } from "../shared/config/index"
import { describeQuota, readQuota } from "../widgets/beat/index"

export const runQuotaCli = (home: string, json: boolean) =>
  Effect.gen(function*() {
    const config = yield* readDispatchConfig(backlogPaths(backlogRoot(home)).dispatchConfig)
    const reading = yield* readQuota(config.quota)
    yield* Console.log(json ? JSON.stringify(reading) : describeQuota(reading))
  })
