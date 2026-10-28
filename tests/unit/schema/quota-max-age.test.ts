import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CommandRunner, type QuotaProviderId, QuotaSource, quotaSourceLayer } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

const askedArgv = (providers: ReadonlyArray<QuotaProviderId>): ReadonlyArray<string> => {
  const asked: Array<ReadonlyArray<string>> = [];
  Effect.runSync(
    Effect.gen(function* () {
      const quota = yield* QuotaSource;
      return yield* quota.read(providers);
    }).pipe(
      Effect.provide(
        quotaSourceLayer.pipe(
          Layer.provide(
            Layer.succeed(CommandRunner, {
              run: (command) => {
                asked.push(command.argv);
                return Effect.succeed(fixture("quota-axi/full.json"));
              },
            }),
          ),
        ),
      ),
    ),
  );
  if (asked.length !== 1) throw new Error(`quota-axi was run ${asked.length} times`);
  const [argv] = asked;
  return argv;
};

// quota-axi's help: --max-age takes 0, a whole-unit duration such as 45s, 2m or 1h, or bare seconds.
const maxAgeSeconds = (argv: ReadonlyArray<string>): number | undefined => {
  const at = argv.indexOf("--max-age");
  if (at === -1) return undefined;
  const match = /^(\d+)([smh]?)$/u.exec(argv[at + 1] ?? "");
  if (match === null) throw new Error(`--max-age ${argv[at + 1]} is no duration quota-axi reads`);
  const unit = match[2];
  return Number(match[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
};

describe("the quota-axi read behind the quota panel", () => {
  test("lets quota-axi reuse a Claude reading up to 5 minutes old", () => {
    expect(maxAgeSeconds(askedArgv(["claude", "codex", "opencode-go"]))).toBe(5 * 60);
    expect(maxAgeSeconds(askedArgv(["claude"]))).toBe(5 * 60);
  });

  test("asks the vendor afresh when Claude is not among the providers asked", () => {
    expect(maxAgeSeconds(askedArgv(["codex", "opencode-go"]))).toBeUndefined();
  });
});
