import { expect, test } from "bun:test"
import { unlinkedTools } from "../../scripts/check-doc-links"

const registry = [
  { name: "nono", url: "https://nono.sh" },
  { name: "no-mistakes", url: "https://github.com/kunchenguid/no-mistakes" }
]
const unlinked = (source: string): Array<string> => unlinkedTools(source, registry).map((tool) => tool.name)

test("rejects a page that names a tool and never links its URL", () => {
  expect(unlinked("# Run\nThe run works inside the nono sandbox.\n")).toEqual(["nono"])
  expect(unlinked("No-mistakes opens the pull request.\nnono is a sandbox, as [its docs](https://nono.sh/docs) say.\n")).toEqual(["nono", "no-mistakes"])
})

test("rejects a link anywhere on the page failing to count for the tool", () => {
  expect(unlinked("The [nono](https://nono.sh) sandbox.\nLater nono again.\n")).toEqual([])
  expect(unlinked("Install [`no-mistakes`](https://github.com/kunchenguid/no-mistakes/).\n")).toEqual([])
  expect(unlinked("See [the sandbox][sandbox] and nono.\n\n[sandbox]: https://nono.sh\n")).toEqual([])
})

test("rejects a mention in code, link text, a path or a longer word failing the page", () => {
  const source = [
    "---",
    "title: nono",
    "---",
    "Run `no-mistakes --version`.",
    "```sh",
    "nono run",
    "```",
    "Read [Installing no-mistakes](run/installing-no-mistakes.md) and docs/run/no-mistakes-fork.md.",
    "The no-mistakes-prod-only mode and the nonogram.",
    "Fetch https://github.com/kunchenguid/no-mistakes/releases first."
  ].join("\n")
  expect(unlinked(source)).toEqual([])
})
