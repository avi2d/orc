import { expect, test } from "bun:test"
import { ByteSize, Deferred, Effect, FileSystem, Layer, Option, PlatformError } from "effect"
import { TestClock } from "effect/testing"
import { DrawerController } from "../../../packages/herdr-app/src/drawer-controller"
import { drawerTerminal } from "../../../packages/herdr-app/src/drawer-terminal"
import { whileSessionExists } from "../../../packages/run/src/features/chat/chat-lifetime"

const absent = Option.none()
const file: FileSystem.File.Info = {
  type: "File", mtime: absent, atime: absent, birthtime: absent, dev: 1, ino: Option.some(42),
  mode: 0o600, nlink: absent, uid: absent, gid: absent, rdev: absent, size: ByteSize.bytes(0), blksize: absent, blocks: absent
}
const ok = { code: 0, stdout: "", stderr: "" }

const drawer = () => {
  const files = new Map<string, FileSystem.File.Info>()
  let launch: string[] = []
  let shows = 0
  const terminal = drawerTerminal({
    createEmpty: (path) => Promise.resolve(files.set(path, file)),
    exec: (program, args) => {
      if (program === "ln") {
        const source = files.get(args[0])
        if (source === undefined) throw new Error("Missing link source")
        files.set(args[1], source)
      } else if (program === "rm") {
        files.delete(args[1])
      } else if (program !== "mkdir") {
        throw new Error("Unexpected command " + program)
      }
      return Promise.resolve(ok)
    },
    hc: (args) => {
      if (args[0] === "get") return Promise.resolve({ ...ok, stdout: '{"state":"live"}' })
      launch = args.slice(args.indexOf("--") + 1)
      return Promise.resolve({ ...ok, stdout: '{"address":"terminal-1"}' })
    }
  }, "/home/example")
  const controller = new DrawerController({
    ...terminal,
    show: () => String(++shows),
    hide: () => undefined
  })
  const fs = FileSystem.layerNoop({ stat: (path) => Effect.suspend(() => {
    const info = files.get(path)
    return info === undefined
      ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "stat" }))
      : Effect.succeed(info)
  }) })
  return { files, fs, controller, launch: () => launch }
}

type End = "close" | "toggle" | "gone:1" | "unlink" | "replace"
type Supervisor = typeof whileSessionExists

const afterDrawerEnds = async (end: End, supervise: Supervisor) => {
  const host = drawer()
  await host.controller.obey("toggle")
  const [env, binding, orc, chat, flag, session] = host.launch()
  expect([env, orc, chat, flag]).toEqual(["env", "orc", "chat", "--session"])
  const key = "ORC_CHAT_DRAWER_LEASE="
  expect(binding.startsWith(key)).toBe(true)
  return Effect.runPromise(Effect.gen(function*() {
    let piRunning = false
    const started = yield* Deferred.make<void>()
    const pi = Effect.gen(function*() {
      piRunning = true
      yield* Deferred.succeed(started, undefined)
      return yield* Effect.never
    }).pipe(Effect.ensuring(Effect.sync(() => { piRunning = false })))
    const terminal = yield* supervise(pi, session, binding.slice(key.length)).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    if (end === "unlink") host.files.delete(session)
    else if (end === "replace") host.files.set(session, { ...file, ino: Option.some(43) })
    else yield* Effect.promise(() => host.controller.obey(end))
    yield* TestClock.adjust("2 seconds")
    return { terminalRunning: terminal.pollUnsafe() === undefined, piRunning }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(host.fs, TestClock.layer()))))
}

const expectStopped = async (end: End, supervise: Supervisor) =>
  expect(await afterDrawerEnds(end, supervise)).toEqual({ terminalRunning: false, piRunning: false })

for (const end of ["close", "toggle", "gone:1", "unlink", "replace"] as const) {
  test(end + " does not leave the chat terminal or Pi running", () => expectStopped(end, whileSessionExists))
}

test.failing("waiting only for Pi leaves the chat terminal running after the session is unlinked", () =>
  expectStopped("unlink", (pi) => pi))

test("installing the drawer does not launch Pi while the drawer is closed", () => {
  expect(drawer().launch()).toEqual([])
})

test("closing a replaced overlay does not stop the chat shown in its replacement", async () => {
  const host = drawer()
  await host.controller.obey("toggle")
  const launch = host.launch()
  await host.controller.obey("show:turns")
  await host.controller.obey("gone:1")
  expect(host.launch()).toBe(launch)
  expect(host.files.size).toBe(2)
  await host.controller.dispose()
  expect([...host.files.keys()]).toEqual([launch[5]])
})

test("an already closed drawer does not spawn Pi against a missing lease", async () => {
  const host = drawer()
  await host.controller.obey("toggle")
  const [, binding, , , , session] = host.launch()
  await host.controller.obey("close")
  const pi = Effect.die("spawned Pi")
  expect(await Effect.runPromise(whileSessionExists(pi, session, binding.split("=")[1]).pipe(Effect.provide(host.fs)))).toBe(0)
})
