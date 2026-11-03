import { BunFileSystem } from "@effect/platform-bun";
import { Clock, Duration, Effect, Fiber, FileSystem, Layer, Scheduler } from "effect";

export interface Spent {
  readonly waitedMillis: number;
  // CPU time, which a busy host does not stretch the way it stretches wall-clock time.
  readonly workedMillis: number;
}

interface Wake {
  readonly at: number;
  readonly resume: () => void;
}

class Changes {
  private waiting: Array<() => void> = [];

  next(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  changed(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }
}

class InFlight {
  private count = 0;
  private readonly changes: Changes;

  constructor(changes: Changes) {
    this.changes = changes;
  }

  get idle(): boolean {
    return this.count === 0;
  }

  enter(): void {
    this.count += 1;
    this.changes.changed();
  }

  leave(): void {
    this.count -= 1;
    this.changes.changed();
  }

  around<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      this.enter();
      return Effect.ensuring(effect, Effect.sync(() => this.leave()));
    });
  }
}

const countedFile = (file: FileSystem.File, flight: InFlight): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  stat: flight.around(file.stat),
  seek: (offset, from) => flight.around(file.seek(offset, from)),
  sync: flight.around(file.sync),
  read: (buffer) => flight.around(file.read(buffer)),
  readAlloc: (size) => flight.around(file.readAlloc(size)),
  truncate: (length) => flight.around(file.truncate(length)),
  write: (buffer) => flight.around(file.write(buffer)),
  writeAll: (buffer) => flight.around(file.writeAll(buffer)),
});

// Finalizers run last-added first, so the close the open adds runs between the enter added after it and the leave added before it.
const countedOpen = (fs: FileSystem.FileSystem, flight: InFlight): FileSystem.FileSystem["open"] => (path, options) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => flight.leave()));
    const file = yield* flight.around(fs.open(path, options));
    yield* Effect.addFinalizer(() => Effect.sync(() => flight.enter()));
    return countedFile(file, flight);
  });

const countedFileSystem = (fs: FileSystem.FileSystem, flight: InFlight): FileSystem.FileSystem =>
  FileSystem.make({
    access: (path, options) => flight.around(fs.access(path, options)),
    copy: (from, to, options) => flight.around(fs.copy(from, to, options)),
    copyFile: (from, to) => flight.around(fs.copyFile(from, to)),
    chmod: (path, mode) => flight.around(fs.chmod(path, mode)),
    chown: (path, uid, gid) => flight.around(fs.chown(path, uid, gid)),
    glob: (pattern, options) => flight.around(fs.glob(pattern, options)),
    link: (from, to) => flight.around(fs.link(from, to)),
    makeDirectory: (path, options) => flight.around(fs.makeDirectory(path, options)),
    makeTempDirectory: (options) => flight.around(fs.makeTempDirectory(options)),
    makeTempDirectoryScoped: (options) => flight.around(fs.makeTempDirectoryScoped(options)),
    makeTempFile: (options) => flight.around(fs.makeTempFile(options)),
    makeTempFileScoped: (options) => flight.around(fs.makeTempFileScoped(options)),
    open: countedOpen(fs, flight),
    readDirectory: (path, options) => flight.around(fs.readDirectory(path, options)),
    readFile: (path) => flight.around(fs.readFile(path)),
    readLink: (path) => flight.around(fs.readLink(path)),
    realPath: (path) => flight.around(fs.realPath(path)),
    remove: (path, options) => flight.around(fs.remove(path, options)),
    rename: (from, to) => flight.around(fs.rename(from, to)),
    stat: (path) => flight.around(fs.stat(path)),
    symlink: (from, to) => flight.around(fs.symlink(from, to)),
    truncate: (path, length) => flight.around(fs.truncate(path, length)),
    utimes: (path, atime, mtime) => flight.around(fs.utimes(path, atime, mtime)),
    // A watch lasts as long as its reader, so counting it would hold the clock still.
    watch: (path, options) => fs.watch(path, options),
    writeFile: (path, data, options) => flight.around(fs.writeFile(path, data, options)),
  });

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const nanosOf = (millis: number): bigint => BigInt(millis) * 1_000_000n;

// The clock moves only once nothing but its sleeps is left to run, so a read waits exactly as long as the reads it follows.
// The program reads files only through the file system it is handed, and awaits no other promise while a sleep is pending,
// since a wait this cannot see lets the clock move early.
export const spentOn = async <E>(program: (fileSystem: Layer.Layer<FileSystem.FileSystem>) => Effect.Effect<void, E>): Promise<Spent> => {
  const started = Date.now();
  let now = started;
  let queued = 0;
  const wakes: Array<Wake> = [];
  const changes = new Changes();
  const flight = new InFlight(changes);
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => nanosOf(now),
    currentTimeNanos: Effect.sync(() => nanosOf(now)),
    monotonicTimeNanosUnsafe: () => nanosOf(now - started),
    monotonicTimeNanos: Effect.sync(() => nanosOf(now - started)),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const wake = { at: now + Duration.toMillis(duration), resume: () => resume(Effect.void) };
        wakes.push(wake);
        changes.changed();
        return Effect.sync(() => {
          wakes.splice(wakes.indexOf(wake), 1);
        });
      }),
  };
  const scheduler = new Scheduler.MixedScheduler("async", (task) => {
    queued += 1;
    changes.changed();
    let ran = false;
    const turn = setImmediate(() => {
      ran = true;
      queued -= 1;
      task();
      changes.changed();
    });
    return () => {
      if (ran) return;
      queued -= 1;
      clearImmediate(turn);
    };
  });
  const fileSystem = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, (fs) => countedFileSystem(fs, flight))).pipe(
    Layer.provide(BunFileSystem.layer),
  );
  const cpu = process.cpuUsage();
  const fiber = Effect.runFork(Effect.provideService(program(fileSystem), Clock.Clock, clock), { scheduler });
  fiber.addObserver(() => changes.changed());
  const quiet = (): boolean => queued === 0 && flight.idle;
  while (fiber.pollUnsafe() === undefined) {
    if (!quiet() || wakes.length === 0) {
      await changes.next();
      continue;
    }
    await nextTurn();
    const next = quiet() ? wakes.toSorted((left, right) => left.at - right.at)[0] : undefined;
    if (next === undefined) continue;
    wakes.splice(wakes.indexOf(next), 1);
    now = next.at;
    next.resume();
  }
  const used = process.cpuUsage(cpu);
  await Effect.runPromise(Effect.orDie(Fiber.join(fiber)));
  return { waitedMillis: now - started, workedMillis: (used.user + used.system) / 1000 };
};
