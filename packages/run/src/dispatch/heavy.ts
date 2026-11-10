import type { HeavyConfig } from "../orc-config"

export const heavyGroup = "heavy"

export const standinDirSuffix = "/heavy/bin"

export const heavyBinDir = (home: string): string => home + standinDirSuffix

export const withHeavyPath = (home: string, path: string): string => heavyBinDir(home) + ":" + path

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
