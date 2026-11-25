import { expect, mock, test } from "bun:test"
import type { AsyncContext, Context } from "gpui-kit"
import { ByteSize, Deferred, Effect, FileSystem, Layer, Option, PlatformError } from "effect"
import { TestClock } from "effect/testing"
import { DrawerController } from "../../../packages/herdr-app/src/drawer-controller"
import { drawerTerminal } from "../../../packages/herdr-app/src/drawer-terminal"
import { whileDrawerOpen } from "../../../packages/run/src/features/chat/chat-lifetime"

const absent = Option.none()
const fileInfo: FileSystem.File.Info = {
  type: "File", mtime: absent, atime: absent, birthtime: absent, dev: 1, ino: absent,
  mode: 0o600, nlink: absent, uid: absent, gid: absent, rdev: absent, size: ByteSize.bytes(0), blksize: absent, blocks: absent
}
const ok = { code: 0, stdout: "", stderr: "" }
const appPid = 4242
const home = "/home/example"
const folder = home + "/.orc/chat"

interface Stored {
  readonly info: FileSystem.File.Info
  readonly text: string
}

const notFound = (method: string) => Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method }))

const notFoundTerminal = { code: 1, stdout: "", stderr: '{"error":{"kind":"not_found"}}' }

const fakeHerdr = (saved: ReadonlyArray<string> = [], earlierLive: ReadonlyArray<string> = []) => {
  const files = new Map<string, Stored>()
  const store = (path: string, text: string) => {
    files.set(path, { info: fileInfo, text })
  }
  const live = new Set(earlierLive)
  const finished = new Set<string>()
  const leases = new Map<string, string>()
  const finish = (address: string) => {
    live.delete(address)
    finished.add(address)
  }
  const kills: Array<string> = []
  for (const name of saved) store(folder + "/" + name, "")
  const launches: Array<ReadonlyArray<string>> = []
  const removals: Array<Promise<typeof ok>> = []
  let appRunning = true
  return {
    files,
    finish,
    finished,
    launches,
    kills,
    removals,
    quitApp: () => { appRunning = false },
    ownerRunning: (pid: number) => Effect.sync(() => appRunning && pid === appPid),
    write: (path: string, text: string) => Promise.resolve(store(path, text)),
    exec: (program: string, args: ReadonlyArray<string>) => {
      if (program === "ls") {
        const names = [...files.keys()].filter((path) => path.startsWith(folder + "/")).map((path) => path.slice(folder.length + 1))
        return Promise.resolve({ ...ok, stdout: names.join("\n") + "\n" })
      }
      if (program === "sh") return Promise.resolve({ ...ok, stdout: String(appPid) + "\n" })
      if (program === "rm") {
        const completed = Promise.resolve().then(() => {
          const lease = args[1] ?? ""
          files.delete(lease)
          const address = leases.get(lease)
          if (address !== undefined) finish(address)
          return ok
        })
        removals.push(completed)
        return completed
      }
      if (program !== "mkdir") throw new Error("Unexpected command " + program)
      return Promise.resolve(ok)
    },
    hc: (args: ReadonlyArray<string>) => {
      const [command, terminal = ""] = args
      if (command === "get") {
        const state = live.has(terminal) ? "live" : finished.has(terminal) ? "finished" : null
        return Promise.resolve(state === null ? notFoundTerminal : { ...ok, stdout: JSON.stringify({ state }) })
      }
      if (command === "rm") {
        if (!finished.delete(terminal)) throw new Error("Cannot remove a terminal before exit: " + terminal)
        return Promise.resolve(ok)
      }
      if (command === "kill") {
        kills.push(terminal)
        live.delete(terminal)
        return Promise.resolve(ok)
      }
      if (command !== "run") throw new Error("Unexpected hc command " + command)
      launches.push(args)
      const address = "terminal-" + String(launches.length)
      const binding = args.find((arg) => arg.startsWith("ORC_CHAT_DRAWER_LEASE="))
      if (binding !== undefined) leases.set(binding.slice("ORC_CHAT_DRAWER_LEASE=".length), address)
      live.add(address)
      return Promise.resolve({ ...ok, stdout: '{"address":"' + address + '"}' })
    },
    fs: FileSystem.layerNoop({
      stat: (path) => Effect.suspend(() => {
        const file = files.get(path)
        return file === undefined ? notFound("stat") : Effect.succeed(file.info)
      }),
      readFileString: (path) => Effect.suspend(() => {
        const file = files.get(path)
        return file === undefined ? notFound("readFileString") : Effect.succeed(file.text)
      })
    })
  }
}

const drawer = (saved: ReadonlyArray<string> = []) => {
  const herdr = fakeHerdr(saved)
  let shows = 0
  const controller = new DrawerController({
    ...drawerTerminal({ exec: (program, args) => herdr.exec(program, args), hc: (args) => herdr.hc(args), sleep: unused, write: herdr.write }, home),
    show: () => String(++shows),
    hide: () => undefined
  })
  return { ...herdr, controller }
}

const launchOf = (args: ReadonlyArray<string> | undefined) => {
  const all = args ?? []
  const [env, binding = "", orc, chat, flag, session = ""] = all.slice(all.indexOf("--") + 1)
  expect([env, orc, chat, flag]).toEqual(["env", "orc", "chat", "--session"])
  const key = "ORC_CHAT_DRAWER_LEASE="
  expect(binding.startsWith(key)).toBe(true)
  return { session, lease: binding.slice(key.length), cwd: all[all.indexOf("--cwd") + 1] }
}

type End = "close" | "toggle" | "gone:1" | "dispose" | "unlink" | "quit app"
type Supervisor = typeof whileDrawerOpen

const afterDrawerEnds = async (end: End, supervise: Supervisor) => {
  const host = drawer()
  await host.controller.obey("toggle")
  const { session, lease } = launchOf(host.launches[0])
  return Effect.runPromise(Effect.gen(function*() {
    let piRunning = false
    const started = yield* Deferred.make<void>()
    const pi = Effect.gen(function*() {
      piRunning = true
      yield* Deferred.succeed(started, undefined)
      return yield* Effect.never
    }).pipe(Effect.ensuring(Effect.sync(() => { piRunning = false })))
    const terminal = yield* supervise(pi, { session, lease }, host.ownerRunning).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    if (end === "unlink") host.files.delete(session)
    else if (end === "quit app") host.quitApp()
    else if (end === "dispose") yield* Effect.promise(() => host.controller.dispose())
    else yield* Effect.promise(() => host.controller.obey(end))
    yield* TestClock.adjust("2 seconds")
    return { terminalRunning: terminal.pollUnsafe() === undefined, piRunning }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(host.fs, TestClock.layer()))))
}

for (const end of ["close", "toggle", "gone:1", "dispose", "unlink", "quit app"] as const) {
  test(end + " does not leave the chat terminal or Pi running", async () => {
    expect(await afterDrawerEnds(end, whileDrawerOpen)).toEqual({ terminalRunning: false, piRunning: false })
  })
}

for (const end of ["close", "toggle", "gone:1", "dispose"] as const) {
  test(end + " does not leak a finished drawer terminal or discard a failed start before close", async () => {
    const host = drawer()
    await host.controller.obey("toggle")
    expect(host.launches[0]).not.toContain("--rm")
    host.finish("terminal-1")
    expect(host.finished.has("terminal-1")).toBe(true)
    if (end === "dispose") await host.controller.dispose()
    else await host.controller.obey(end)
    expect([...host.finished]).toEqual([])
  })
}

test("waiting only for Pi leaves the chat terminal and Pi running after the session is unlinked", async () => {
  expect(await afterDrawerEnds("unlink", (pi) => pi)).toEqual({ terminalRunning: true, piRunning: true })
})

test("a drawer with no saved session starts an empty one in ~/.orc/chat and runs the chat from home", async () => {
  const host = drawer()
  await host.controller.obey("toggle")
  const { session, lease, cwd } = launchOf(host.launches[0])
  expect(cwd).toBe(home)
  expect(session).toMatch(/^\/home\/example\/\.orc\/chat\/drawer-\d+\.jsonl$/)
  expect(host.files.get(session)?.text).toBe("")
  expect(host.files.get(lease)?.text).toBe(String(appPid))
})

test("opening the drawer resumes the newest saved session instead of starting an empty one", async () => {
  const host = drawer(["drawer-100.jsonl", "drawer-300.jsonl", "drawer-200.jsonl", "drawer-400.jsonl.5.1.open", "notes.txt"])
  await host.controller.obey("toggle")
  expect(launchOf(host.launches[0]).session).toBe(folder + "/drawer-300.jsonl")
  expect([...host.files.keys()].filter((path) => path.endsWith(".jsonl"))).toHaveLength(3)
})

test("reopening the drawer resumes its session under a lease the earlier chat does not mistake for its own", async () => {
  const host = drawer()
  await host.controller.obey("toggle")
  await host.controller.obey("toggle")
  await host.controller.obey("toggle")
  const [first, second] = [launchOf(host.launches[0]), launchOf(host.launches[1])]
  expect(second.session).toBe(first.session)
  expect(second.lease).not.toBe(first.lease)
  expect(host.files.has(first.lease)).toBe(false)
})

test("closing a replaced overlay does not stop the chat shown in its replacement", async () => {
  const host = drawer()
  await host.controller.obey("toggle")
  const launch = launchOf(host.launches[0])
  await host.controller.obey("show:turns")
  await host.controller.obey("gone:1")
  expect(host.launches).toHaveLength(1)
  expect(host.files.size).toBe(2)
  await host.controller.dispose()
  expect([...host.files.keys()]).toEqual([launch.session])
})

const startsPi = async (ended: (host: ReturnType<typeof drawer>) => Promise<void> | void) => {
  const host = drawer()
  await host.controller.obey("toggle")
  const { session, lease } = launchOf(host.launches[0])
  await ended(host)
  const pi = Effect.die("spawned Pi")
  return Effect.runPromise(whileDrawerOpen(pi, { session, lease }, host.ownerRunning).pipe(Effect.provide(host.fs)))
}

test("an already closed drawer does not spawn Pi against a missing lease", async () => {
  expect(await startsPi((host) => host.controller.obey("close"))).toBe(0)
})

test("an open drawer does not spawn Pi when its session was deleted before launch", async () => {
  expect(await startsPi((host) => { host.files.delete(launchOf(host.launches[0]).session) })).toBe(0)
})

test("a lease left by a Herdr App that has quit does not spawn Pi", async () => {
  expect(await startsPi((host) => host.quitApp())).toBe(0)
})

let app = fakeHerdr()
let sharedValues = new Map<string, unknown>()
const listeners: Array<(command: string) => void> = []
let listening: Array<() => void> = []
const nextListen = () => new Promise<void>((resolve) => { listening.push(resolve) })
const element = (): object => new Proxy({}, { get: (_target, _name, self: object) => () => self })

void mock.module("gpui-kit", () => ({ View: Object, div: element }))
void mock.module("gpui-base", () => ({ h_flex: element, v_flex: element, ScrollHandle: { new: () => ({ scroll_to_item: () => undefined }) } }))
void mock.module("herdr", () => ({
  exec: (program: string, args: ReadonlyArray<string>) => app.exec(program, args),
  hc: (args: ReadonlyArray<string>) => app.hc(args),
  writeTextFile: (path: string, text: string) => app.write(path, text).then(() => null),
  home: () => home,
  shared: (key: string) => sharedValues.get(key),
  setShared: (key: string, value: unknown) => {
    sharedValues.set(key, value)
    return null
  },
  props: () => undefined,
  nextCommand: () => new Promise<string>((resolve) => {
    listeners.push(resolve)
    const waiting = listening
    listening = []
    for (const wake of waiting) wake()
  }),
  openOverlay: () => "overlay-1",
  closeOverlay: () => null,
  readTextFile: () => Promise.resolve(null),
  run: () => null,
  settings: () => ({}),
  theme: () => ({})
}))

const unused = (): never => { throw new Error("Unexpected App context call") }
class IdleEntity {
  set_props = unused
  release = unused
}
const cx: Context = Object.assign(IdleEntity, {
  notify: () => undefined,
  spawn: (body: (task: AsyncContext) => unknown) => {
    void body(cx)
    return { cancel: () => undefined, is_done: () => false }
  },
  focus_handle: () => ({ focus: () => undefined, is_focused: () => false, release: () => true }),
  stop_propagation: unused, bind_keys: unused, propagate: unused, phase: unused, theme: unused, open_url: unused,
  read_from_clipboard: unused, write_to_clipboard: unused, sleep: unused,
  timer: { after: unused, every: unused }
}) satisfies Context

const installDrawer = async (earlierLive: ReadonlyArray<string> = [], shared: ReadonlyMap<string, unknown> = new Map()) => {
  app = fakeHerdr([], earlierLive)
  sharedValues = new Map(shared)
  listeners.length = 0
  const { default: OrcDrawer } = await import("../../../packages/herdr-app/mods/orc-drawer/main")
  const view = new OrcDrawer()
  const installed = nextListen()
  view.init(undefined, cx)
  await installed
  const send = async (command: string) => {
    const handled = nextListen()
    listeners.shift()?.(command)
    await handled
  }
  return { view, send }
}

test("installing the drawer does not launch Pi while the drawer is closed", async () => {
  await installDrawer()
  await Bun.sleep(0)
  expect(app.launches).toEqual([])
})

test("installing the drawer ends the live orc-chat terminal an earlier release left instead of leaving it running", async () => {
  await installDrawer(["orc-chat"])
  await Bun.sleep(0)
  expect(app.kills).toEqual(["orc-chat"])
})

test("installing the drawer ends the earlier release's chat at its shared address once rather than on every install", async () => {
  await installDrawer(["t9"], new Map([["orc-drawer.chat", { address: "t9", session: folder + "/drawer-1.jsonl" }]]))
  await Bun.sleep(0)
  expect(app.kills).toEqual(["t9"])
  expect(sharedValues.get("orc-drawer.chat")).toBeNull()
})

test("installing the drawer kills no terminal when no earlier release's chat is live", async () => {
  await installDrawer([], new Map([["orc-drawer.chat", { address: "t9", session: folder + "/drawer-1.jsonl" }]]))
  await Bun.sleep(0)
  expect(app.kills).toEqual([])
})

test("opening the installed drawer launches one chat rather than none", async () => {
  const { send } = await installDrawer()
  await send("toggle")
  expect(app.launches).toHaveLength(1)
})

test("closing the drawer's App view removes its lease without deleting its transcript", async () => {
  const { view, send } = await installDrawer()
  await send("toggle")
  const { session, lease } = launchOf(app.launches[0])
  expect(app.files.has(lease)).toBe(true)
  view.close(cx)
  expect(app.removals).toHaveLength(1)
  await app.removals[0]
  expect([...app.files.keys()]).toEqual([session])
})
