import type { TaskRecord } from "../../entities/backlog/index"
import { type Account, type DispatchConfig, providerOf, resolveDispatch, type RoutedModels } from "../../shared/config/index"
import type { QuotaReading } from "./quota"

export type TaskRoute =
  | { readonly kind: "waits"; readonly reason: string }
  | { readonly kind: "selected"; readonly account: Account; readonly routed?: RoutedModels }

export const selectTaskRoute = (config: DispatchConfig, quota: QuotaReading, spec: TaskRecord["spec"]): TaskRoute => {
  if (quota.kind === "unread") {
    return { kind: "waits", reason: "no account has room" }
  }
  if (config.routing === undefined || spec.kind === "decision") {
    const account = config.quota.accounts.find((entry) => entry.name === quota.pick)
    return account === undefined ? { kind: "waits", reason: "no account has room" } : { kind: "selected", account }
  }
  const accounts = config.quota.accounts.flatMap((account) => {
    const reading = quota.accounts.find((entry) => entry.account === account.name)
    return reading?.kind === "usable" ? [{ name: account.name, provider: providerOf(config.quota, account), remainingPercent: reading.remainingPercent }] : []
  })
  const route = resolveDispatch(config.routing, { id: spec.id, kind: spec.kind, project: spec.project }, { floorPercent: quota.floorPercent, accounts })
  if (route.kind === "waits") {
    return route
  }
  const account = config.quota.accounts.find((entry) => entry.name === route.account)
  return account === undefined
    ? { kind: "waits", reason: "no account has room for the dispatch route" }
    : { kind: "selected", account, routed: route.models }
}

