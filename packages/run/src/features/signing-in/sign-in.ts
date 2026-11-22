import { Console, Data, Effect, FileSystem, Path, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Command } from "../../shared/process/index"
import { findPrivateWindow, openerScript } from "./private-window"

export const accountNames = ["claude-main", "claude-second", "openai", "opencode"] as const
export type AccountName = typeof accountNames[number]
export const isAccountName = (word: string): word is AccountName => accountNames.some((name) => name === word)

class SignInError extends Data.TaggedError("SignInError")<{
  readonly message: string
}> {}

interface VendorSignIn {
  readonly vendor: string
  readonly command: Command
  readonly folderVar: string
  readonly noBrowserNote: string
  readonly privateBrowserVar: string | null
}

const claudeSignIn: VendorSignIn = {
  vendor: "Claude",
  command: ["claude", "auth", "login"],
  folderVar: "CLAUDE_CONFIG_DIR",
  noBrowserNote: "This machine has no browser, so Claude prints a link instead of opening one. Open the link on any device, sign in, and paste the code the page shows back here.",
  privateBrowserVar: null
}

const signIns: Record<AccountName, VendorSignIn | null> = {
  "claude-main": claudeSignIn,
  "claude-second": { ...claudeSignIn, privateBrowserVar: "BROWSER" },
  openai: null,
  opencode: null
}

type Env = Readonly<Record<string, string | undefined>>

const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== ""

const hasNoBrowser = (env: Env, platform: NodeJS.Platform): boolean =>
  isSet(env, "SSH_CONNECTION") || isSet(env, "SSH_TTY") || (platform === "linux" && !isSet(env, "DISPLAY") && !isSet(env, "WAYLAND_DISPLAY"))

const privateBrowserEnv = (
  account: AccountName,
  vendor: VendorSignIn,
  noBrowser: boolean,
  env: Env,
  platform: NodeJS.Platform
): Effect.Effect<Record<string, string>, SignInError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const browserVar = vendor.privateBrowserVar
    if (browserVar === null) {
      return {}
    }
    if (noBrowser) {
      // An opener the shell exports, such as an editor's remote helper, would open the link outside a private window.
      return { [browserVar]: "" }
    }
    const window = yield* findPrivateWindow(env, platform)
    const fs = yield* FileSystem.FileSystem
    const opener = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped({ prefix: "orc-login-" }), "open-private")
    yield* fs.writeFileString(opener, openerScript(window), { mode: 0o700 })
    yield* Console.log(window.command === null
      ? "orc login " + account + ": orc knows no private window for the default browser " + window.browser + ", so " + vendor.vendor + " prints the link instead. Open it in a private window, so the claude-main browser session is not reused."
      : "orc login " + account + ": " + vendor.vendor + " opens the sign-in link in a private window of " + window.browser + ", so the claude-main browser session is not reused.")
    return { [browserVar]: opener }
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new SignInError({ message: "orc login " + account + " cannot write the private-window opener: " + error.message }))))

const accountFolder = (path: Path.Path, orcHome: string, account: AccountName): string => path.join(orcHome, "accounts", account)

const readyFolder = (folder: string): Effect.Effect<void, SignInError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const linked = yield* fs.readLink(folder).pipe(Effect.as(true), Effect.catchTag("PlatformError", () => Effect.succeed(false)))
    if (linked) {
      return yield* new SignInError({ message: "orc login refuses " + folder + ": it is a link, and an account folder is never shared" })
    }
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError((error) => new SignInError({ message: "orc login cannot make the account folder " + folder + ": " + error.message }))
    )
  })

export const signIn = (
  orcHome: string,
  account: AccountName,
  env: Env,
  platform: NodeJS.Platform
): Effect.Effect<string, SignInError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const vendor = signIns[account]
    if (vendor === null) {
      return yield* new SignInError({ message: "orc login " + account + " is not available yet. Only claude-main and claude-second sign in today." })
    }
    const folder = accountFolder(yield* Path.Path, orcHome, account)
    yield* readyFolder(folder)
    yield* Console.log("orc login " + account + ": " + vendor.vendor + " signs in with " + vendor.folderVar + " set to " + folder)
    const noBrowser = hasNoBrowser(env, platform)
    if (noBrowser) {
      yield* Console.log(vendor.noBrowserNote)
    }
    const browserEnv = yield* privateBrowserEnv(account, vendor, noBrowser, env, platform)
    const [program, ...args] = vendor.command
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // The vendor's sign-in talks to the person on the terminal, and orc never reads what it prints or stores.
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { env: { ...browserEnv, [vendor.folderVar]: folder }, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
    const exitCode = yield* handle.exitCode
    if (exitCode !== 0) {
      return yield* new SignInError({ message: "orc login " + account + ": " + vendor.command.join(" ") + " exited " + String(exitCode) })
    }
    return folder
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(new SignInError({ message: "orc login " + account + ": cannot start " + (signIns[account]?.command.join(" ") ?? account) + ": " + error.message })))
  )
