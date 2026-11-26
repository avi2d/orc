import { Effect, Latch } from "effect";

export const lateQuotaOrTasks = (argv: ReadonlyArray<string>, tasksCommand: string): boolean =>
  argv[0] === "quota-axi" || argv.join(" ").startsWith(`sh -c ${tasksCommand}`);

const lateNameOf = (argv: ReadonlyArray<string>): "quota" | "tasks" => (argv[0] === "quota-axi" ? "quota" : "tasks");

export interface StartOrderProbe {
  readonly events: Array<string>;
  readonly record: (event: string) => Effect.Effect<void>;
  readonly bothStarted: Effect.Effect<void>;
}

export const startOrderProbe = (): StartOrderProbe => {
  const events: Array<string> = [];
  const bothStarted = Latch.makeUnsafe();
  const record = (event: string) =>
    Effect.sync(() => {
      events.push(event);
      if (events.includes("start quota") && events.includes("start tasks")) bothStarted.openUnsafe();
    });
  return { events, record, bothStarted: bothStarted.await };
};

export const lateRead = <A, E, R>(argv: ReadonlyArray<string>, answer: Effect.Effect<A, E, R>, probe: StartOrderProbe): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const name = lateNameOf(argv);
    yield* probe.record(`start ${name}`);
    yield* probe.bothStarted;
    const result = yield* answer;
    yield* probe.record(`end ${name}`);
    return result;
  });

export const startedBesideOthers = (events: ReadonlyArray<string>): boolean => {
  const first = (prefix: string): number => events.findIndex((event) => event.startsWith(prefix));
  const firstEnd = first("end ");
  const firstQuota = first("start quota");
  const firstTasks = first("start tasks");
  return firstQuota !== -1 && firstTasks !== -1 && firstEnd !== -1 && Math.max(firstQuota, firstTasks) < firstEnd;
};
