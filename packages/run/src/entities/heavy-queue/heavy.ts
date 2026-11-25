import type { HeavyConfig } from "../../shared/config/index"
import { agentWrapperDirSuffix, ciOnlyDirSuffix, heavyDirSuffix } from "../../shared/sandbox/index"

export const heavyGroup = "heavy"

export const heavyBinDir = (home: string): string => home + heavyDirSuffix

export const ciOnlyBinDir = (home: string): string => home + ciOnlyDirSuffix

export const ciOnlyBashFile = (home: string): string => home + "/heavy/ci-only.bash"
export const agentWrapperDir = (home: string): string => home + agentWrapperDirSuffix

export const withHeavyPath = (home: string, path: string): string => heavyBinDir(home) + ":" + path

export const runStepPath = (home: string, path: string): string => ciOnlyBinDir(home) + ":" + withHeavyPath(home, path)

export const defaultHeavyTools: ReadonlyArray<string> = [
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "vitest",
  "playwright",
  "jest",
  "go",
  "cargo",
  "node",
  "python",
  "python3",
  "uv",
  "make",
  "deno",
  "pytest",
  "tsc",
  "oxlint",
  "eslint",
  "xcodebuild",
  "xcrun",
]

export interface HeavySettings {
  readonly group: string
  readonly commands: ReadonlyArray<string>
  readonly limit: "auto" | "none"
  readonly through: ReadonlyArray<string> | null
}

export const resolveHeavy = (config: HeavyConfig | undefined): HeavySettings => ({
  group: config?.group ?? heavyGroup,
  commands: config?.commands ?? [],
  limit: config?.limit ?? "auto",
  through: config?.through ?? null
})
