import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { defineConfig, type DefaultTheme } from "vitepress"

const base = process.env["DOCS_BASE"] ?? "/orc/"

const diagrams = join(import.meta.dirname, "..", "diagrams")

const diagramFile = /(?:^|\/)diagrams\/([\w-]+)\.svg$/

const topMap = "how-orc-works"

interface Part {
  readonly id: string
  readonly title: string
  readonly link: string
}

const parts: readonly Part[] = [
  { id: "backlog", title: "The backlog", link: "concepts/backlog" },
  { id: "beat", title: "The beat", link: "concepts/beat" },
  { id: "quota", title: "Accounts and quota", link: "concepts/accounts-and-quota" },
  { id: "runner", title: "The runner", link: "concepts/runner" },
  { id: "run", title: "A run", link: "concepts/run" },
  { id: "checks", title: "Checks and review", link: "concepts/checks-and-review" },
  { id: "merge", title: "The merge", link: "concepts/merge" },
  { id: "attention", title: "The attention queue and the decider", link: "concepts/attention" },
  { id: "chat", title: "The chat", link: "concepts/chat" },
  { id: "app", title: "The app and the dashboard", link: "concepts/app" }
]

// markdown-it renders an image in a synchronous rule, so the drawings are read before the first page renders.
const drawings = new Map(
  await Promise.all(
    (await readdir(diagrams))
      .filter((file) => file.endsWith(".svg"))
      .map((file) => readFile(join(diagrams, file), "utf8").then((markup) => [file, markup] as const))
  )
)

const drawn = (id: string): boolean => drawings.has(id + ".svg")

type Target = (part: Part) => string

const pageOf: Target = (part) => base + part.link

const mapOrPageOf: Target = (part) => (drawn(part.id) ? "#map-" + part.id : pageOf(part))

const linked = /<g data-part="([\w-]+)">([\s\S]*?)<\/g>/g

const box = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/

const heading = /<text[^>]*class="title"[^>]*>([\s\S]*?)<\/text>/

const size = /viewBox="0 0 ([\d.]+) ([\d.]+)"/

const percent = (value: string | undefined, of: string | undefined): string => ((Number(value) / Number(of)) * 100).toFixed(3) + "%"

const layout = (name: string, kind: string, target: Target): string => {
  const source = drawings.get(name + (kind === "tall" ? "-tall" : "") + ".svg")
  if (source === undefined) return ""
  const drawing = source.replace(/<style>[\s\S]*?<\/style>/, "")
  const [, width, height] = size.exec(drawing) ?? []
  const links = [...drawing.matchAll(linked)].map(([, id, inner]) => {
    const part = parts.find((candidate) => candidate.id === id)
    const [, x, y, w, h] = box.exec(inner) ?? []
    const label = (heading.exec(inner)?.[1] ?? "").replaceAll(/<[^>]+>/g, "")
    if (part === undefined) return ""
    const place = "left:" + percent(x, width) + ";top:" + percent(y, height) + ";width:" + percent(w, width) + ";height:" + percent(h, height)
    return '<a class="map-link" href="' + target(part) + '" style="' + place + '" aria-label="' + label + '"></a>'
  })
  return '<span class="diagram-' + kind + '">' + drawing + links.join("") + "</span>"
}

const layouts = (name: string, target: Target): string => layout(name, "wide", target) + layout(name, "tall", target)

const bar = (inner: string): string => '<span class="map-bar">' + inner + "</span>"

const diagram = (name: string): string =>
  '<span class="diagram vp-raw" v-pre>' + (parts.some((part) => part.id === name) ? bar('<a href="' + base + '#map">← The whole map</a>') : "") + layouts(name, pageOf) + "</span>"

const deeper = (part: Part): string =>
  '<span class="map-deep" id="map-' + part.id + '">' +
  bar('<a href="#map">← The whole map</a><strong>' + part.title + '</strong><a href="' + pageOf(part) + '">Read the page →</a>') +
  layouts(part.id, mapOrPageOf) +
  "</span>"

const explorer = (): string =>
  '<span class="diagram map vp-raw" id="map" v-pre><span class="map-top">' +
  bar("Select a part to see how it works.") +
  layouts(topMap, mapOrPageOf) +
  "</span>" +
  parts.filter((part) => drawn(part.id)).map(deeper).join("") +
  "</span>"

const page = (text: string, link: string): DefaultTheme.SidebarItem => ({ text, link })

const start = [
  page("How orc works", "/"),
  page("What orc does", "/features"),
  page("Where orc is going", "/roadmap")
]

const concepts = parts.map((part) => page(part.title, "/" + part.link))

const tasks = [
  page("Run your first task", "/tasks/run-your-first-task"),
  page("Run a backlog from the chat", "/tasks/run-a-backlog"),
  page("Pick a task kind", "/pick-a-task-kind"),
  page("Pick a delivery mode", "/pick-a-delivery-mode"),
  page("Merge a PR and turn on yolo", "/merge-a-pr"),
  page("Give a project its own instructions", "/project-instructions"),
  page("Follow up on upstream contributions", "/upstream-contributions"),
  page("Install no-mistakes", "/run/installing-no-mistakes"),
  page("Choose the no-mistakes binary", "/run/choosing-the-no-mistakes-binary"),
  page("Grant toolchain folders to the sandbox", "/run/toolchain-folders"),
  page("Show orc in the Herdr App", "/herdr-app"),
  page("Open orc-dash", "/dash"),
  page("Contribute", "/contribute")
]

const reference = [
  page("Commands", "/reference/commands"),
  page("The backlog and the beat", "/run/backlog-and-beat"),
  page("Task kinds", "/run/task-kinds"),
  page("Delivery modes", "/run/delivery-modes"),
  page("Running a task", "/run/running-a-task"),
  page("How orc runs Pi", "/run/how-orc-runs-pi"),
  page("Running without a sandbox", "/run/running-without-a-sandbox"),
  page("Configuring providers", "/run/configuring-providers"),
  page("The runner", "/run/runner"),
  page("The heavy queue", "/run/heavy-queue"),
  page("Parked runs", "/run/parked-runs"),
  page("The attention queue", "/run/attention-queue"),
  page("Adding tasks from a chat", "/run/chat"),
  page("Merging a task's PR", "/run/merging-a-tasks-pr"),
  page("Seeing runs", "/run/seeing-runs"),
  page("What the no-mistakes fork adds", "/run/no-mistakes-fork"),
  page("Move an old launcher", "/run/move-an-old-launcher"),
  page("Where things are in the run package", "/run/layout")
]

const sessionQuota = [
  page("Run the session panel", "/session-quota/run-the-session-panel"),
  page("Capture usage as it happens", "/session-quota/capture"),
  page("Compose two machines", "/session-quota/compose-two-machines"),
  page("Read the JSON report", "/session-quota/json-report"),
  page("Tail the alert stream", "/session-quota/alert-stream"),
  page("Troubleshoot the session panel", "/session-quota/troubleshoot")
]

const repository = "https://github.com/avi2d/orc"

// A link out of docs/ names a file of the repository, which the site does not hold.
const leavesTheSite = /^(?:\.\.\/)+(?!docs\/)/

const htmlTags = new Set(["a", "b", "br", "code", "details", "em", "i", "img", "kbd", "span", "strong", "sub", "summary", "sup"])

const isHtmlTag = (markup: string): boolean => htmlTags.has((/^<\/?([A-Za-z][\w-]*)/.exec(markup)?.[1] ?? "").toLowerCase())

export default defineConfig({
  title: "orc",
  description: "How orc runs AI agent tasks across your machines, and how to use it",
  base,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: base + "favicon.svg" }]],
  cleanUrls: true,
  lastUpdated: true,
  rewrites: { "adr/README.md": "adr/index.md" },
  ignoreDeadLinks: [leavesTheSite],
  markdown: {
    config: (md) => {
      const image = md.renderer.rules.image
      md.renderer.rules.image = (tokens, index, options, env, self) => {
        const name = diagramFile.exec(tokens.at(index)?.attrGet("src") ?? "")?.[1]
        if (name !== undefined) return name === topMap ? explorer() : diagram(name)
        return image === undefined ? self.renderToken(tokens, index, options) : image(tokens, index, options, env, self)
      }
      // Vue compiles each page as a template, so a placeholder such as <folder> in prose would be read as an unclosed element.
      md.renderer.rules.html_inline = (tokens, index) => {
        const markup = tokens.at(index)?.content ?? ""
        return isHtmlTag(markup) ? markup : md.utils.escapeHtml(markup)
      }
    }
  },
  themeConfig: {
    nav: [
      { text: "How orc works", link: "/" },
      { text: "Concepts", link: "/concepts/backlog" },
      { text: "Tasks", link: "/tasks/run-your-first-task" },
      { text: "Commands", link: "/reference/commands" }
    ],
    sidebar: [
      { text: "Start here", items: start },
      { text: "Concepts", items: concepts },
      { text: "Tasks", items: tasks },
      { text: "Reference", items: reference },
      { text: "Session quota panel", collapsed: true, items: sessionQuota },
      { text: "Decisions", collapsed: true, items: [page("Decision records", "/adr/")] }
    ],
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
    editLink: { pattern: repository + "/edit/main/docs/:path", text: "Edit this page on GitHub" }
  }
})
