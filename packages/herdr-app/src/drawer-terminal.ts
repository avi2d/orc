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
  readonly write: (path: string, text: string) => Promise<unknown>
}

const output = (result: Result): string => {
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || "Command exited " + String(result.code))
  return result.stdout
}

const savedSession = /^drawer-(\d+)\.jsonl$/

const newestSaved = (listing: string): string | null => {
  let newest: { readonly name: string; readonly stamp: number } | null = null
  for (const name of listing.split("\n")) {
    const saved = savedSession.exec(name.trim())
    if (saved === null) continue
    const stamp = Number(saved[1])
    if (newest === null || stamp > newest.stamp) newest = { name: saved[0], stamp }
  }
  return newest?.name ?? null
}

// Names the App only while herdr's exec runs the shell as the App's direct child.
const appProcess = (result: Result): string => {
  const pid = output(result).trim()
  if (!/^\d+$/.test(pid)) throw new Error("Cannot read the Herdr App's process id: " + pid)
  return pid
}

export const drawerTerminal = (host: TerminalHost, home: string): DrawerTerminal => {
  const folder = [home, ".orc", "chat"].join("/")
  let launched = 0
  const release = (lease: string) => host.exec("rm", ["-f", lease]).then(output)
  const savedOrNew = (): Promise<string> => host.exec("ls", ["-1", folder]).then(output).then((listing) => {
    const saved = newestSaved(listing)
    if (saved !== null) return [folder, saved].join("/")
    const created = [folder, "drawer-" + String(Date.now()) + ".jsonl"].join("/")
    return host.write(created, "").then(() => created)
  })
  const launch = (session: string, lease: string): Promise<DrawerChat> => {
    const args = ["run", "--bg", "--json", "--no-parent", "--cwd", home, "--", "env", "ORC_CHAT_DRAWER_LEASE=" + lease, "orc", "chat", "--session", session]
    return host.hc(args).then(output).then((text) => {
      const address = guardJson(text, (value, at) => {
        const record = fields(value, at)
        return record.kind === "refused" ? record : string(record.value, "address", at)
      })
      if (address.kind === "refused") throw new Error(address.reason)
      return { address: address.value, session, lease }
    })
  }
  return {
    start(): Promise<DrawerChat> {
      return host.exec("mkdir", ["-p", folder]).then(output)
        .then(savedOrNew)
        .then((session) => host.exec("sh", ["-c", "echo $PPID"]).then(appProcess).then((owner) => {
          const lease = [session, String(Date.now()), String(++launched), "open"].join(".")
          return host.write(lease, owner)
            .then(() => launch(session, lease))
            .catch((error: unknown) => release(lease).then(() => { throw error }))
        }))
    },
    stop: (chat: DrawerChat): Promise<void> => release(chat.lease).then(() => undefined),
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
