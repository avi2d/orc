import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { defineConfig, type DefaultTheme } from "vitepress"

const base = process.env["DOCS_BASE"] ?? "/orc/"

const diagrams = join(import.meta.dirname, "..", "diagrams")

const diagramFile = /(?:^|\/)diagrams\/([\w-]+)\.svg$/

const inlineSvg = (file: string, layout: string): string =>
  existsSync(file)
    ? '<span class="diagram-' + layout + '">' + readFileSync(file, "utf8").replace(/<style>[\s\S]*?<\/style>/, "") + "</span>"
    : ""

const diagram = (name: string): string =>
  '<span class="diagram" v-pre>' + inlineSvg(join(diagrams, name + ".svg"), "wide") + inlineSvg(join(diagrams, name + ".tall.svg"), "tall") + "</span>"

const page = (text: string, link: string): DefaultTheme.SidebarItem => ({ text, link })

const start = [
  page("How orc works", "/"),
  page("What orc does", "/features"),
  page("Where orc is going", "/roadmap")
]

const concepts = [
  page("The backlog", "/concepts/backlog"),
  page("The beat", "/concepts/beat"),
  page("Accounts and quota", "/concepts/accounts-and-quota"),
  page("The runner", "/concepts/runner"),
  page("A run", "/concepts/run"),
  page("Checks and review", "/concepts/checks-and-review"),
  page("The merge", "/concepts/merge"),
  page("The attention queue", "/concepts/attention"),
  page("The chat", "/concepts/chat"),
  page("The App and the dashboard", "/concepts/app")
]

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
  srcExclude: process.env["DOCS_DEMO"] === undefined ? ["demo/**"] : [],
  cleanUrls: true,
  lastUpdated: true,
  rewrites: { "adr/README.md": "adr/index.md" },
  ignoreDeadLinks: [leavesTheSite],
  markdown: {
    config: (md) => {
      const fence = md.renderer.rules.fence
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens.at(index)
        if (token === undefined || token.info.trim() !== "mermaid") {
          return fence === undefined ? self.renderToken(tokens, index, options) : fence(tokens, index, options, env, self)
        }
        return "<MermaidDiagram code=\"" + encodeURIComponent(token.content) + "\" />"
      }
      const image = md.renderer.rules.image
      md.renderer.rules.image = (tokens, index, options, env, self) => {
        const name = diagramFile.exec(tokens.at(index)?.attrGet("src") ?? "")?.[1]
        if (name !== undefined) return diagram(name)
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
