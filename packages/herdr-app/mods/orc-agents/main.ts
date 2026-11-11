import { type Runs, runs } from "../../src/guard"
import { FactView, count } from "../../src/fact-view"
import { type Reading, readJson } from "../../src/orc-read"

export default class OrcAgents extends FactView<Runs> {
  readonly title = "Agents"
  readonly command = "orc runs --json"
  readonly everyMs = 15_000

  read(): Promise<Reading<Runs>> {
    return readJson("orc", ["runs", "--json"], runs)
  }

  fact(document: Runs): string {
    return `${count(document.runs.length, "run", "runs")} in the run history`
  }
}
