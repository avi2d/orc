import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const systemTempRoots = ["/tmp", "/private/tmp", "/var", "/private/var"]
const underSystemTemp = (candidate: string): boolean =>
  systemTempRoots.some((root) => candidate === root || candidate.startsWith(root + "/"))
const homeBase = (cwd: string, systemTmp: string): string =>
  !underSystemTemp(cwd) ? cwd : (!underSystemTemp(systemTmp) ? systemTmp : cwd)

// nono refuses a HOME whose state root falls under the /var or /tmp it grants, so the fixture home is not under the system temp dir.
export const makeNonoFixtureHome = (prefix: string): Promise<string> =>
  mkdtemp(join(homeBase(process.cwd(), tmpdir()), prefix))
