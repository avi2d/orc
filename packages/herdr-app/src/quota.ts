import { type Guard, arrayOf, child, fields, literal, ok, string } from "./guard"

interface Account {
  readonly title: string
}

const account: Guard<Account> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const title = string(record.value, "title", at)
  if (title.kind === "refused") return title
  return ok({ title: title.value })
}

type Quota =
  | { readonly status: "ok"; readonly accounts: ReadonlyArray<Account> }
  | { readonly status: "failed"; readonly error: string }

const quota: Guard<Quota> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  if (record.value["status"] === "failed") {
    const error = string(record.value, "error", at)
    if (error.kind === "refused") return error
    return ok({ status: "failed", error: error.value })
  }
  const status = literal(record.value, "status", at, "ok")
  if (status.kind === "refused") return status
  const report = fields(record.value["report"], child(at, "report"))
  if (report.kind === "refused") return report
  const accounts = arrayOf(report.value, "accounts", child(at, "report"), account)
  if (accounts.kind === "refused") return accounts
  return ok({ status: "ok", accounts: accounts.value })
}

export interface QuotaSnapshot {
  readonly schemaVersion: 1
  readonly quota: Quota
}

export const quotaSnapshot: Guard<QuotaSnapshot> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const schemaVersion = literal(record.value, "schemaVersion", at, 1)
  if (schemaVersion.kind === "refused") return schemaVersion
  const sources = fields(record.value["sources"], child(at, "sources"))
  if (sources.kind === "refused") return sources
  const answer = quota(sources.value["quota"], child(child(at, "sources"), "quota"))
  if (answer.kind === "refused") return answer
  return ok({ schemaVersion: schemaVersion.value, quota: answer.value })
}
