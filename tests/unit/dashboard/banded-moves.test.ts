import { describe, expect, test } from "bun:test";
import { plain } from "@tui-dash/ui";
import { bandedScreen, type Step, stepped } from "../../lib/host-fixture";

const size = { columns: 240, rows: 40 };

const screen = bandedScreen();

const after = (steps: ReadonlyArray<Step>) => stepped(screen, size, steps);

const frameAfter = (steps: ReadonlyArray<Step>): string => screen.draw(0, after(steps), size.columns, size.rows).block.map(plain).join("\n");

const pickedAfter = (steps: ReadonlyArray<Step>): string =>
  screen
    .draw(0, after(steps), size.columns, size.rows)
    .block.flatMap((line) => line.filter((part) => part.style.background === "pick").map((part) => part.text))
    .join("");

const onHarbor: ReadonlyArray<Step> = [{ move: "down" }, { move: "up" }];

describe("the dashboard's moves", () => {
  test("pick the next project down and the first one back up from home, leaving the focus at home", () => {
    expect(after([{ move: "down" }]).focus).toBeUndefined();
    expect(pickedAfter([{ move: "down" }])).toContain("kelp");
    expect(frameAfter([{ move: "down" }, { move: "down" }])).toBe(frameAfter([{ move: "down" }]));
    expect(pickedAfter(onHarbor)).toContain("harbor");
  });

  // The finished project only joins the board once t switches it to every task.
  test("reach the finished project once the board lists all", () => {
    const all: ReadonlyArray<Step> = [{ press: "t" }, { move: "down" }, { move: "down" }];
    expect(pickedAfter(all)).toContain("notes");
    expect(frameAfter([...all, { move: "down" }])).toBe(frameAfter(all));
  });

  test("step from home into the projects and back out to it", () => {
    expect(after([{ move: "in" }]).focus).toBe("tasks");
    expect(after([{ move: "in" }, { move: "out" }]).focus).toBeUndefined();
  });

  test("a step out to home and back in keeps the held pick", () => {
    const back = [...onHarbor, { move: "in" }, { move: "in" }, { move: "out" }, { move: "out" }, { move: "in" }] satisfies ReadonlyArray<Step>;
    expect(after(back).focus).toBe("tasks");
    expect(frameAfter(back)).toBe(frameAfter([...onHarbor, { move: "in" }]));
  });

  test("move within the levels once stepped in", () => {
    const into: ReadonlyArray<Step> = [...onHarbor, { move: "in" }];
    expect(frameAfter([...into, { move: "in" }])).not.toBe(frameAfter(into));
    expect(frameAfter([...into, { move: "in" }, { move: "out" }])).toBe(frameAfter(into));
  });

  test("leave the page keys alone outside the full-screen ledger", () => {
    const into: ReadonlyArray<Step> = [...onHarbor, { move: "in" }, { move: "in" }];
    expect(frameAfter([...into, { move: "pageup" }])).toBe(frameAfter(into));
    expect(frameAfter([...into, { move: "pagedown" }])).toBe(frameAfter(into));
  });
});
