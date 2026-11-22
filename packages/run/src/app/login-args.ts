import { accountNames, type AccountName, isAccountName } from "../features/signing-in/index"

export type LoginArgs = { readonly kind: "Login"; readonly account: AccountName }

export const parseLoginArgs = (rest: readonly string[]): LoginArgs | { readonly kind: "UsageError"; readonly detail: string } => {
  const [account = ""] = rest
  return rest.length === 1 && isAccountName(account)
    ? { kind: "Login", account }
    : { kind: "UsageError", detail: "orc login takes one account: " + accountNames.join(", ") }
}
