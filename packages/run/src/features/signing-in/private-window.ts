import { Effect, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { capture } from "../../shared/process/index"

export interface PrivateWindow {
  readonly browser: string
  readonly command: ReadonlyArray<string> | null
}

type Env = Readonly<Record<string, string | undefined>>

const linuxBrowsers: ReadonlyArray<readonly [string, string, string]> = [
  ["firefox", "firefox", "--private-window"],
  ["librewolf", "librewolf", "--private-window"],
  ["google-chrome", "google-chrome", "--incognito"],
  ["chromium", "chromium", "--incognito"],
  ["brave", "brave-browser", "--incognito"],
  ["microsoft-edge", "microsoft-edge", "--inprivate"],
  ["vivaldi", "vivaldi", "--incognito"]
]

const macBrowsers: Readonly<Partial<Record<string, readonly [string, string]>>> = {
  "org.mozilla.firefox": ["Firefox", "--private-window"],
  "com.google.chrome": ["Google Chrome", "--incognito"],
  "org.chromium.chromium": ["Chromium", "--incognito"],
  "com.brave.browser": ["Brave Browser", "--incognito"],
  "com.microsoft.edgemac": ["Microsoft Edge", "--inprivate"],
  "com.vivaldi.vivaldi": ["Vivaldi", "--incognito"]
}

const LaunchServices = Schema.Struct({
  LSHandlers: Schema.Array(Schema.Struct({ LSHandlerURLScheme: Schema.optional(Schema.String), LSHandlerRoleAll: Schema.optional(Schema.String) }))
})

const decodeLaunchServices = Schema.decodeOption(Schema.fromJsonString(LaunchServices))

const printed = (command: readonly [string, ...Array<string>]): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(command, null).pipe(
    Effect.map((result) => result.exitCode === 0 ? result.stdout.trim() : null),
    Effect.catchTag("RunnerError", () => Effect.succeed(null))
  )

const linuxWindow = Effect.map(printed(["xdg-settings", "get", "default-web-browser"]), (desktop): PrivateWindow => {
  const known = desktop === null ? undefined : linuxBrowsers.find(([key]) => desktop.toLowerCase().includes(key))
  return { browser: desktop ?? "unknown", command: known === undefined ? null : [known[1], known[2]] }
})

// macOS keeps no default for https until the person picks a browser, and then Safari opens links.
const macWindow = (env: Env) =>
  Effect.map(
    printed(["plutil", "-convert", "json", "-o", "-", (env.HOME ?? "") + "/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"]),
    (json): PrivateWindow => {
      const bundle = Option.fromNullishOr(json).pipe(
        Option.flatMap(decodeLaunchServices),
        Option.map(({ LSHandlers }) => (LSHandlers.find((handler) => handler.LSHandlerURLScheme === "https")?.LSHandlerRoleAll ?? "com.apple.safari").toLowerCase()),
        Option.getOrElse(() => "unknown")
      )
      const known = macBrowsers[bundle]
      return { browser: bundle, command: known === undefined ? null : ["open", "-na", known[0], "--args", known[1]] }
    }
  )

export const findPrivateWindow = (env: Env, platform: NodeJS.Platform): Effect.Effect<PrivateWindow, never, ChildProcessSpawner.ChildProcessSpawner> =>
  platform === "linux" ? linuxWindow : platform === "darwin" ? macWindow(env) : Effect.succeed({ browser: "unknown", command: null })

const quoted = (word: string): string => "'" + word.replaceAll("'", "'\\''") + "'"

// The vendor runs its browser variable as one program with the link as its only argument, so the private-window flags live in a script.
export const openerScript = (window: PrivateWindow): string =>
  window.command === null ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\nexec " + window.command.map(quoted).join(" ") + " \"$1\"\n"
