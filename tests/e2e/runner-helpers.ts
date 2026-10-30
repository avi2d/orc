import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname
const pueueFixtures = new URL("../fixtures/runner/pueue", import.meta.url).pathname

export const startWaitMillis = 10_000
export const runnerTimeout = 60_000

export interface Fixture {
  readonly dir: string
  readonly home: string
  readonly checkout: string
  readonly pueue: string
  readonly env: Record<string, string>
}

export interface OrcResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const fakePueue = [
  "#!/bin/sh",
  "case \"$1\" in",
  "  status) cat \"$PUEUE_STATE/status.json\" ;;",
  "  group)",
  "    if [ \"$2\" = \"add\" ]; then printf '%s\\n' \"$@\" > \"$PUEUE_STATE/group-add-args.tmp\"; mv \"$PUEUE_STATE/group-add-args.tmp\" \"$PUEUE_STATE/group-add-args\";",
  "      if [ -f \"$PUEUE_STATE/fail-add\" ]; then echo \"fake pueue cannot add groups\" >&2; exit 1; fi;",
  "      while ! mkdir \"$PUEUE_STATE/group-lock\" 2>/dev/null; do sleep 0.05; done;",
  "      if [ -f \"$PUEUE_STATE/groups.json\" ]; then groups=$(cat \"$PUEUE_STATE/groups.json\");",
  "      else groups='{\"default\":{\"status\":\"Running\",\"parallel_tasks\":1},\"orc\":{\"status\":\"Running\",\"parallel_tasks\":1}}'; fi;",
  "      case \"$groups\" in *\"\\\"$3\\\"\":*) echo \"Group \\\"$3\\\" already exists\" >&2; rmdir \"$PUEUE_STATE/group-lock\"; exit 1 ;; esac;",
  "      if [ -f \"$PUEUE_STATE/groups.json\" ]; then stripped=$(printf '%s' \"$groups\" | sed 's/}$//'); printf '%s,\"%s\":{\"status\":\"Running\",\"parallel_tasks\":1}}' \"$stripped\" \"$3\" > \"$PUEUE_STATE/groups.json\"; fi;",
  "      rmdir \"$PUEUE_STATE/group-lock\";",
  "      if [ -f \"$PUEUE_STATE/race-add\" ]; then echo \"Group \\\"$3\\\" already exists\" >&2; exit 1; fi;",
  "      echo \"Group $3 created\";",
  "    elif [ \"$2\" = \"--json\" ]; then",
  "      if [ -f \"$PUEUE_STATE/group-gate\" ]; then printf '%s\\n' \"$$\" >> \"$PUEUE_STATE/group-reads\"; while [ -f \"$PUEUE_STATE/group-gate\" ]; do sleep 0.05; done; fi;",
  "      if [ -f \"$PUEUE_STATE/groups.json\" ]; then cat \"$PUEUE_STATE/groups.json\";",
  "      else printf '%s' '{\"default\":{\"status\":\"Running\",\"parallel_tasks\":1},\"orc\":{\"status\":\"Running\",\"parallel_tasks\":1}}'; fi;",
  "    else echo \"fake pueue has no group $2\" >&2; exit 2; fi ;;",
  "  add)",
  "    shift; : > \"$PUEUE_STATE/add-args.tmp\"; label=\"\"; group=\"\";",
  "    while [ \"$#\" -gt 0 ]; do case \"$1\" in",
  "      --) printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; while [ \"$#\" -gt 0 ]; do printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; done; break ;;",
  "      -w|--working-directory|-g|--group|-l|--label|-d|--delay|-a|--after|-o|--priority) flag=\"$1\"; printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; if [ \"$#\" -eq 0 ]; then echo \"fake pueue refuses add option without value\" >&2; exit 2; fi; case \"$1\" in -*) echo \"fake pueue refuses add option without value\" >&2; exit 2 ;; esac; case \"$flag\" in -g|--group) group=\"$1\" ;; -l|--label) label=\"$1\" ;; esac; printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift ;;",
  "      -e|--escape|-i|--immediate|--follow|-s|--stashed|-p|--print-task-id) printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift ;;",
  "      -*) echo \"fake pueue refuses add option $1\" >&2; exit 2 ;;",
  "      *) while [ \"$#\" -gt 0 ]; do printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; done; break ;;",
  "    esac; done;",
  "    if [ -f \"$PUEUE_STATE/groups.json\" ]; then groups=$(cat \"$PUEUE_STATE/groups.json\");",
  "    else groups='{\"default\":{\"status\":\"Running\",\"parallel_tasks\":1},\"orc\":{\"status\":\"Running\",\"parallel_tasks\":1}}'; fi;",
  "    case \"$groups\" in *\"\\\"$group\\\"\":*) ;; *) echo \"fake pueue has no group $group\" >&2; exit 2 ;; esac;",
  "    while ! mkdir \"$PUEUE_STATE/group-lock\" 2>/dev/null; do sleep 0.05; done;",
  "    if [ -f \"$PUEUE_STATE/added-tasks\" ]; then n=$(wc -l < \"$PUEUE_STATE/added-tasks\"); else n=0; fi;",
  "    id=$((77 + n)); printf '%s %s %s\\n' \"$label\" \"$group\" \"$id\" >> \"$PUEUE_STATE/added-tasks\"; if [ ! -f \"$PUEUE_STATE/fail-spawn\" ]; then : > \"$PUEUE_STATE/live-$id\"; fi;",
  "    mv \"$PUEUE_STATE/add-args.tmp\" \"$PUEUE_STATE/add-args\";",
  "    printf '%s' \"$ORC_HOME\" > \"$PUEUE_STATE/add-env.tmp\"; mv \"$PUEUE_STATE/add-env.tmp\" \"$PUEUE_STATE/add-env\";",
  "    rmdir \"$PUEUE_STATE/group-lock\"; echo \"$id\" ;;",
  "  wait)",
  "    id=\"$2\"; while [ -f \"$PUEUE_STATE/live-$id\" ]; do sleep 0.05; done ;;",
  "  kill)",
  "    id=\"$2\"; rm -f \"$PUEUE_STATE/live-$id\"; printf '%s\\n' \"$id\" >> \"$PUEUE_STATE/killed-tasks\"; echo \"Killed $id\" ;;",
  "  *) echo \"fake pueue has no $1\" >&2; exit 2 ;;",
  "esac",
  ""
].join("\n")

export const withFixture = async (body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-runner-e2e-"))
  try {
    const bin = join(dir, "bin")
    const pueue = join(dir, "pueue")
    const home = join(dir, "home")
    const checkout = join(dir, "linux-orc")
    await mkdir(bin)
    await mkdir(join(home, "backlog"), { recursive: true })
    await mkdir(checkout)
    await cp(pueueFixtures, pueue, { recursive: true })
    await writeFile(join(bin, "pueue"), fakePueue)
    await chmod(join(bin, "pueue"), 0o755)
    await writeFile(join(dir, "task.md"), "# Do the thing\n\nWith a body that holds 'quotes' and $dollars.\n")
    await writeFile(join(home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { linux: checkout } }] }))
    await body({ dir, home, checkout, pueue, env: { ORC_HOME: home, PUEUE_STATE: pueue, PATH: bin + ":" + (process.env.PATH ?? "") } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const runOrc = async (
  fixture: Fixture,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin: string | null = null
): Promise<OrcResult> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], {
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ...fixture.env, ...env }
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

export const orcOk = async (fixture: Fixture, args: ReadonlyArray<string>, env: Record<string, string> = {}): Promise<string> => {
  const result = await runOrc(fixture, args, env)
  if (result.exitCode !== 0) {
    throw new Error("orc " + args.join(" ") + " exited " + result.exitCode + ": " + result.stderr)
  }
  return result.stdout
}

export const fakeQuota = async (fixture: Fixture): Promise<void> => {
  const status = { schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] }
  await writeFile(join(fixture.dir, "bin", "orc-quota"), "#!/bin/sh\ncat <<'J'\n" + JSON.stringify(status) + "\nJ\n")
  await chmod(join(fixture.dir, "bin", "orc-quota"), 0o755)
}

export const queuedArgs = async (fixture: Fixture): Promise<ReadonlyArray<string> | null> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    const text = await readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)
    if (text !== null) {
      return text.split("\n").slice(0, -1)
    }
    await Bun.sleep(20)
  }
  return null
}

export const queuedEnv = async (fixture: Fixture): Promise<string | null> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    const text = await readFile(join(fixture.pueue, "add-env"), "utf8").catch(() => null)
    if (text !== null) {
      return text
    }
    await Bun.sleep(20)
  }
  return null
}

export const orcThere = (home: string): ReadonlyArray<string> => ["sh", "-c", "ORC_HOME='" + home + "' exec \"$0\" '" + binPath + "' \"$@\"", process.execPath]
