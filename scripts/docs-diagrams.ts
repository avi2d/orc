import { app } from "./diagrams/app"
import { attention } from "./diagrams/attention"
import { backlog } from "./diagrams/backlog"
import { beat } from "./diagrams/beat"
import { chat } from "./diagrams/chat"
import { checks } from "./diagrams/checks"
import { merge } from "./diagrams/merge"
import { quota } from "./diagrams/quota"
import { run } from "./diagrams/run"
import { runner } from "./diagrams/runner"
import { top } from "./diagrams/top"

for (const draw of [top, backlog, beat, quota, runner, run, checks, merge, attention, chat, app]) {
  try {
    draw()
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
