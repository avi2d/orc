import { type QuotaSnapshot, quotaSnapshot } from "../../src/guard"
import { FactView } from "../../src/fact-view"
import { type Reading, readJson } from "../../src/orc-read"

export default class OrcResources extends FactView<QuotaSnapshot> {
  readonly title = "Resources"
  readonly command = "orc-dash snapshot --json --only quota"
  readonly everyMs = 60_000

  read(): Promise<Reading<QuotaSnapshot>> {
    return readJson("orc-dash", ["snapshot", "--json", "--only", "quota"], quotaSnapshot)
  }

  fact(document: QuotaSnapshot): string {
    if (document.quota.status === "failed") {
      return `orc-dash read no quota: ${document.quota.error}`
    }
    const names = document.quota.accounts.map((account) => account.title)
    return names.length === 0 ? "No accounts in the quota report" : `Accounts: ${names.join(", ")}`
  }
}
