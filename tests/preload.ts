import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Bun reads os.homedir() once at start, so ORC_HOME is what keeps this process's own orc reads off the account's ~/.orc.
const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-test-home-")))
const home = join(root, "home")
const orcHome = join(root, "orc-home")
mkdirSync(home)
mkdirSync(orcHome)
process.env.HOME = home
process.env.ORC_HOME = orcHome

// bun test never emits the process exit event, so the folder goes when the file's last test ends.
afterAll(() => rmSync(root, { recursive: true, force: true }))
