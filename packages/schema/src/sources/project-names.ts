import { Duration, Effect } from "effect";
import type { CommandRunner } from "../command";

export type ProjectNames = ReadonlyMap<string, string>;

// A path names a project only on the machine that ran it.
export type MachineProjects = ReadonlyMap<string, ProjectNames>;

export const unknownProject = "unknown";

export interface ProjectResolver {
  readonly resolve: (paths: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly known: Effect.Effect<ProjectNames>;
}

const unresolvable: ProjectResolver = { resolve: () => Effect.void, known: Effect.succeed(new Map()) };

const gitTimeout = Duration.seconds(10);

const runCopyRepository = /^(.*\/\.no-mistakes)\/worktrees\/([^/]+)\//u;

const shellQuoted = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

// A finished run's copy is gone, but the repository it was copied from is kept.
const repositoriesOf = (path: string): ReadonlyArray<string> => {
  const copied = runCopyRepository.exec(path);
  return copied === null ? [path] : [path, `${copied[1]}/repos/${copied[2]}.git`];
};

// printf answers one line for every path, even when git reads nothing, so the answers line up with the paths.
const originLine = (path: string): string => {
  const reads = repositoriesOf(path).map((repository) => `git -C ${shellQuoted(repository)} config --get remote.origin.url 2>/dev/null`);
  return `printf '%s\\n' "$(${reads.join(" || ")})"`;
};

const nameOfOrigin = (origin: string | undefined): string => {
  const name = origin?.trim().replace(/\/+$/u, "").replace(/\.git$/u, "").split(/[/:]/u).at(-1);
  return name === undefined || name === "" ? unknownProject : name;
};

// A path is only remembered once its shell ran, so a dropped connection is asked again on the next read.
const projectResolver = (runner: CommandRunner["Service"], argvOf: (script: string) => readonly [string, ...string[]]): ProjectResolver => {
  const names = new Map<string, string>();
  return {
    resolve: (paths) => {
      const asked = [...new Set(paths)].filter((path) => !names.has(path));
      if (asked.length === 0) return Effect.void;
      return runner.run({ argv: argvOf(asked.map(originLine).join("; ")), timeout: gitTimeout }).pipe(
        Effect.map((stdout) => {
          const origins = stdout.replace(/\n$/u, "").split("\n").slice(-asked.length);
          asked.forEach((path, index) => names.set(path, nameOfOrigin(origins[index])));
        }),
        Effect.catchTag("CommandUnreachable", () => Effect.void),
      );
    },
    known: Effect.sync(() => new Map(names)),
  };
};

export const localProjects = (runner: CommandRunner["Service"]): ProjectResolver => projectResolver(runner, (script) => ["sh", "-c", script]);

// Only plain words before a bare pueue status are a way onto the machine; pueue named by its path, a quote or a shell operator among them is not.
const sshCall = /^((?:[^\s'"`;&|()<>\\]+\s+)+)['"]?pueue\s+status(?:\s|$)/u;

const sshPrefixOf = (command: string): string | undefined => sshCall.exec(command.trim())?.[1]?.trim();

// ssh joins its arguments into one line for the other machine's shell, so the script is quoted once more for that shell.
// Without the ssh call before pueue there is no way onto that machine, and this machine's git would read another checkout.
export const remoteProjects = (runner: CommandRunner["Service"], command: string): ProjectResolver => {
  const prefix = sshPrefixOf(command);
  return prefix === undefined ? unresolvable : projectResolver(runner, (script) => ["sh", "-c", `${prefix} ${shellQuoted(script)}`]);
};
