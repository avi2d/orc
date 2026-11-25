import type { DrawerChat, DrawerTerminal } from "./drawer-controller"
import { fields, guardJson, ok, string } from "./guard"

interface Result {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface TerminalHost {
  readonly exec: (program: string, args: string[]) => Promise<Result>
  readonly hc: (args: string[]) => Promise<Result>
  readonly createEmpty: (path: string) => Promise<unknown>
}

const output = (result: Result): string => {
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || "Command exited " + String(result.code))
  return result.stdout
}

const leasePath = (session: string): string => session + ".open"

export const drawerTerminal = (host: TerminalHost, home: string): DrawerTerminal => {
  const release = (session: string) => host.exec("rm", ["-f", leasePath(session)]).then(output)
  return {
    start(): Promise<DrawerChat> {
      const folder = [home, ".orc", "chat"].join("/")
      const session = [folder, "drawer-" + String(Date.now()) + ".jsonl"].join("/")
      const args = ["run", "--bg", "--json", "--no-parent", "--cwd", folder, "--", "env", "ORC_CHAT_DRAWER_LEASE=" + leasePath(session), "orc", "chat", "--session", session]
      return host.exec("mkdir", ["-p", folder]).then(output)
        .then(() => host.createEmpty(session))
        .then(() => host.exec("ln", [session, leasePath(session)]))
        .then(output)
        .then(() => host.hc(args).then(output).then((text) => {
          const address = guardJson(text, (value, at) => {
            const record = fields(value, at)
            return record.kind === "refused" ? record : string(record.value, "address", at)
          })
          if (address.kind === "refused") throw new Error(address.reason)
          return { address: address.value, session }
        }).catch((error: unknown) => release(session).then(() => { throw error })))
    },
    stop: (chat: DrawerChat): Promise<void> => release(chat.session).then(() => undefined),
    live: (chat: DrawerChat): Promise<boolean> => host.hc(["get", chat.address, "--json"]).then((result) => {
      const live = guardJson(result.stdout || result.stderr, (value, at) => {
        const record = fields(value, at)
        if (record.kind === "refused") return record
        const error = fields(record.value["error"], "error")
        if (error.kind === "ok" && error.value["kind"] === "not_found") return ok(false)
        output(result)
        const state = string(record.value, "state", at)
        return state.kind === "refused" ? state : ok(state.value === "live")
      })
      if (live.kind === "refused") throw new Error(live.reason)
      return live.value
    })
  }
}
