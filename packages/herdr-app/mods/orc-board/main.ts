import { type Backlog, backlog } from "../../src/guard"
import { FactView, count } from "../../src/fact-view"
import { type Reading, readJson } from "../../src/orc-read"

export default class OrcBoard extends FactView<Backlog> {
  readonly title = "Board"
  readonly command = "orc backlog --json"
  readonly everyMs = 15_000

  read(): Promise<Reading<Backlog>> {
    return readJson("orc", ["backlog", "--json"], backlog)
  }

  fact(document: Backlog): string {
    return `${count(document.tasks.length, "task", "tasks")} in the backlog`
  }
}
