import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mountedOf, plain, soloScreen, span } from "@tui-dash/ui";

describe("a solo screen through a refresh", () => {
  // Oracle: liveScreen draws only after a defined read; the mount reads 1 and one refresh must show 2.
  test("the read is defined and one refresh moves the frame from 1 to 2", async () => {
    let count = 0;
    const mounted = await Effect.runPromise(
      mountedOf({
        name: "solo",
        cadence: "1 second",
        reach: "none",
        read: Effect.sync(() => {
          count += 1;
          return count;
        }),
        pending: () => false,
        refreshing: () => false,
        freshness: () => [],
        placed: (reading) => ({ 
          box: () => ({ block: [[span(`count ${reading()}`, "foreground")]], targets: [] }),
          natural: () => 3,
          least: () => 3,
          glance: () => [],
        }),
      }),
    );
    expect(count).toBe(1);
    const screen = soloScreen(mounted);
    expect(plain(screen.draw(false, mounted.start, 40, 10).block[0] ?? [])).toContain("count 1");
    const value = await Effect.runPromise(screen.read);
    expect(value).toBe(true);
    expect(count).toBe(2);
    expect(plain(screen.draw(value, mounted.start, 40, 10).block[0] ?? [])).toContain("count 2");
  });
});
