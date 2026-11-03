import { describe, expect, test } from "bun:test";
import { panel, plain, wrapParts } from "@tui-dash/ui";

// Oracle: a box 20 columns wide keeps both top corners in its 20 columns, so a 15 column title room takes "queue · north" and an
// ellipsis, worked by hand. Rejects a long title that pushes the top right corner out of the box.
describe("a panel", () => {
  test("a title kept to two rows shows queue to the new rather than dropping new", () => {
    expect(wrapParts("Move the bridge queue to the new runner".split(" "), 16, " ", 2).slice(0, 2)).toEqual(["Move the bridge", "queue to the new"]);
  });
  test("cuts a title too long for its top edge and keeps the corner", () => {
    expect(panel("queue · north · 3 running · 1 waiting", [], 20).map(plain)).toEqual(["╭─ queue · north… ─╮", `╰${"─".repeat(18)}╯`]);
  });
});
