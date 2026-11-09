import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

const systemTempRoots = ["/tmp", "/private/tmp", "/var", "/private/var"]
const underSystemTemp = (candidate: string): boolean =>
  systemTempRoots.some((root) => candidate === root || candidate.startsWith(root + "/"))

// nono refuses a HOME under the /var or /tmp it grants, a killed run leaves whatever it made in the checkout, and an orc sandbox denies writes to the account's cache but owns its TMPDIR.
export const nonoFixtureRoot = (systemTmp: string = tmpdir()): string =>
  underSystemTemp(systemTmp) ? join(userInfo().homedir, ".cache", "orc-tests") : systemTmp

export const makeNonoFixtureDir = async (prefix: string): Promise<string> => {
  const root = nonoFixtureRoot()
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, prefix))
}
