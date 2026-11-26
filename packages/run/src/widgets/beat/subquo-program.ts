import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

export const installedSubquo = (base: string, platform: string, arch: string, version: string): string | undefined => {
  try {
    const manifest = createRequire(base).resolve("@avi2dg/subquo-" + platform + "-" + arch + "/package.json")
    const binary = join(dirname(manifest), "subquo-" + version)
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
}
