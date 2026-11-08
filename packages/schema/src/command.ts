import { Context, Data, type Duration, type Effect } from "effect";

export interface Command {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly exitCodes?: ReadonlyArray<number>;
  readonly stdin?: string;
  readonly timeout: Duration.Duration;
}

export const acceptsExit = (command: Command, code: number): boolean => (command.exitCodes ?? [0]).includes(code);

export class CommandUnreachable extends Data.TaggedError("CommandUnreachable")<{
  readonly reason: string;
}> {}

export class CommandAbsent extends Data.TaggedError("CommandAbsent")<{
  readonly reason: string;
}> {}

export class CommandRunner extends Context.Service<
  CommandRunner,
  { readonly run: (command: Command) => Effect.Effect<string, CommandUnreachable | CommandAbsent> }
>()("tui-dash/CommandRunner") {}
