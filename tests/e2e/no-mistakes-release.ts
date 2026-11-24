import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const version = "v1.100.2"

const archives: Readonly<Partial<Record<string, { readonly platform: string; readonly sha256: string }>>> = {
  "linux-x64": { platform: "linux-amd64", sha256: "b975ab7a4cf26aa483a7c7ecd68d718ecbb646ab903f56dc411987fbef1c8b7b" },
  "linux-arm64": { platform: "linux-arm64", sha256: "3a620ad602358dc8a95bbd83eabc2dc6b8f882fe191a9f08ac089d1b072a49a1" },
  "darwin-arm64": { platform: "darwin-arm64", sha256: "daa19c92e751084c0b67c7abb02ad93f9f865fc577157cad2e6e3d1ea783d3bb" },
  "darwin-x64": { platform: "darwin-amd64", sha256: "86c4556498b8ce06bbbea24a9843e27fc44ac7079d817b39d9bacebc44b16d9c" }
}

// The generated CI workflows hold no step of the repository's own, so the e2e tier fetches the pinned release itself. The latest release upstream marks is a prerelease orc refuses, so the pin is explicit.
export const fetchPinnedNoMistakes = async (): Promise<string> => {
  const archive = archives[process.platform + "-" + process.arch]
  if (archive === undefined) throw new Error("no pinned no-mistakes " + version + " archive for " + process.platform + " " + process.arch)
  const folder = join(tmpdir(), "orc-no-mistakes-" + version + "-" + archive.platform)
  const binary = join(folder, "no-mistakes")
  if (await Bun.file(binary).exists()) return binary
  const name = "no-mistakes-" + version + "-" + archive.platform + ".tar.gz"
  const response = await fetch("https://github.com/kunchenguid/no-mistakes/releases/download/" + version + "/" + name)
  if (!response.ok) throw new Error("fetching " + name + " answered HTTP " + response.status)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (sum !== archive.sha256) throw new Error(name + " has sha256 " + sum + ", not the pinned " + archive.sha256)
  const staging = await mkdtemp(join(tmpdir(), "orc-no-mistakes-fetch-"))
  try {
    await Bun.write(join(staging, name), bytes)
    const untar = Bun.spawnSync(["tar", "xzf", join(staging, name), "-C", staging, "no-mistakes"])
    if (untar.exitCode !== 0) throw new Error("tar could not unpack " + name + ": " + untar.stderr.toString())
    await mkdir(folder, { recursive: true })
    await rename(join(staging, "no-mistakes"), binary)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return binary
}
