export type Tone = "plain" | "work" | "ask" | "ok" | "end"

export interface MapPart {
  readonly id: string
  readonly title: string
  readonly text?: string
  readonly points?: readonly string[]
  readonly tone?: Tone
  readonly inside?: string
  readonly page?: string
  readonly mono?: true
}

export interface MapLink {
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly tone: "work" | "ask"
}

export const mapTitle = "How orc works"

// A part with inner parts takes no link of its own: a link names the innermost part it touches.
export const parts: readonly MapPart[] = [
  { id: "you", title: "You" },
  { id: "plans", title: "The machine that plans" },
  { id: "works", title: "A machine that works" },
  { id: "ends", title: "How a task ends" },

  { id: "chat", inside: "you", title: "The chat", text: "Say the work. Answer questions.", page: "concepts/chat" },
  { id: "app", inside: "you", title: "The app and the dashboard", text: "Show it all. Hold no state.", page: "concepts/app" },
  { id: "merge", mono: true, inside: "you", title: "orc merge", text: "Land a pull request once CI is green.", page: "concepts/merge" },

  { id: "backlog", inside: "plans", title: "The backlog", text: "One file per task, in priority order.", page: "concepts/backlog" },
  {
    id: "backlog-new", mono: true,
    inside: "backlog",
    title: "new",
    tone: "work",
    text: "Waiting to start, in priority order. It waits while:",
    points: ["it has no priority", "you hold it", "a question has no answer", "it depends on an open task", "no machine has a free slot", "no account has room"]
  },
  { id: "backlog-taken", mono: true, inside: "backlog", title: "taken", text: "A beat took it. Its run is queued or running on a machine." },
  {
    id: "backlog-closed", mono: true,
    inside: "backlog",
    title: "closed",
    text: "It keeps its outcome and the reason:",
    points: ["done, with a pull request or a report", "failed or start-failed", "stopped", "dropped"]
  },
  { id: "kinds", inside: "backlog", title: "Task kinds", text: "The kind of a task decides how it ends." },
  { id: "kind-ship", mono: true, inside: "kinds", title: "ship", text: "The default. Changes code and ends in a pull request." },
  { id: "kind-scout", mono: true, inside: "kinds", title: "scout", text: "Reads the project and changes nothing. Ends in a report." },
  { id: "kind-task", mono: true, inside: "kinds", title: "task", text: "Does the work it describes. Ends in a report with its evidence." },
  { id: "kind-parent", mono: true, inside: "kinds", title: "parent", text: "Holds work too large for one pull request. Ends once its children are done." },
  { id: "kind-decision", mono: true, inside: "kinds", title: "decision", text: "Asks you a question and never runs. Ends with your answer." },

  { id: "quota", inside: "plans", title: "Quota", tone: "work", text: "Room left on each account.", page: "concepts/accounts-and-quota" },
  { id: "beat", inside: "plans", title: "The beat", text: "Every few minutes, starts what can start.", page: "concepts/beat" },

  { id: "attention", inside: "plans", title: "The attention queue", tone: "ask", text: "Every open question waits here.", page: "concepts/attention" },
  { id: "att-question", inside: "attention", title: "A question from a run", tone: "ask", text: "The review raised it, or the agent asked it instead of guessing." },
  {
    id: "att-news",
    inside: "attention",
    title: "News for you",
    tone: "ask",
    points: ["a run died", "a check went red", "a pull request is ready", "a hold is overdue", "a command keeps failing"]
  },
  {
    id: "att-guarded",
    inside: "attention",
    title: "Is it on a guarded topic?",
    tone: "ask",
    points: ["deleting, or anything that cannot be undone", "security, keys and logins", "merging, pushing, releasing", "spending", "a site's look, and legal text"]
  },
  { id: "att-you", inside: "attention", title: "It waits for you", tone: "ask", text: "Answer in the chat, in the app, or with orc backlog answer. Your answer replaces the decider's." },
  { id: "att-answered", inside: "attention", title: "Answered", tone: "ok", text: "The run carries on where it waited." },

  { id: "decider", inside: "plans", title: "The decider", tone: "ask", text: "A small model. It answers a routine question by quoting a rule you wrote.", page: "concepts/attention" },
  { id: "dec-reads", inside: "decider", title: "What it reads", tone: "ask", text: "Your rules, the project's instructions and the task. It has no tools." },
  { id: "dec-quote", inside: "decider", title: "Can it quote a rule that settles it?", tone: "ask", text: "It may answer only by quoting your rule, word for word." },

  { id: "runner", inside: "works", title: "The runner", text: "A queue on the machine, a few tasks at a time.", page: "concepts/runner" },
  { id: "run", inside: "works", title: "A run", text: "An agent writes the change in its own copy of the project, on a new branch.", page: "concepts/run" },
  { id: "checks", inside: "works", title: "Checks and review", text: "The agent fixes what the checks refuse. Then a review reads the branch.", page: "concepts/checks-and-review" },

  { id: "dropped", inside: "ends", title: "Dropped", tone: "end", text: "Before it started." },
  { id: "answered", inside: "ends", title: "Answered", tone: "end", text: "A decision never runs. Your answer closes it." },
  { id: "stopped", inside: "ends", title: "Stopped", tone: "end", text: "You stopped the run." },
  { id: "failed", inside: "ends", title: "Failed", tone: "end", text: "It could not start, it died, or its checks stayed red." },
  { id: "report", inside: "ends", title: "A report", tone: "ok", text: "A task that changes no code. No pull request." },
  { id: "pull-request", inside: "ends", title: "A pull request", tone: "ok", text: "A code change. You merge it once CI is green." }
]

export const links: readonly MapLink[] = [
  { from: "chat", to: "backlog-new", label: "add a task", tone: "work" },
  { from: "backlog-new", to: "backlog-taken", label: "a beat takes it", tone: "work" },
  { from: "backlog-taken", to: "backlog-closed", label: "the run ends", tone: "work" },
  { from: "backlog-taken", to: "backlog-new", label: "its run stops on a question", tone: "ask" },
  { from: "backlog-closed", to: "backlog-new", label: "orc backlog send-back", tone: "ask" },
  { from: "backlog-new", to: "beat", tone: "work" },
  { from: "quota", to: "beat", tone: "work" },
  { from: "beat", to: "runner", label: "starts a task", tone: "work" },
  { from: "runner", to: "run", tone: "work" },
  { from: "run", to: "checks", tone: "work" },
  { from: "checks", to: "att-question", label: "a question", tone: "ask" },
  { from: "att-question", to: "att-guarded", tone: "ask" },
  { from: "att-guarded", to: "att-you", label: "yes", tone: "ask" },
  { from: "att-guarded", to: "dec-reads", label: "no", tone: "ask" },
  { from: "dec-reads", to: "dec-quote", tone: "ask" },
  { from: "dec-quote", to: "att-answered", label: "yes", tone: "ask" },
  { from: "dec-quote", to: "att-you", label: "no", tone: "ask" },
  { from: "att-news", to: "att-you", tone: "ask" },
  { from: "att-you", to: "chat", label: "the rest wait for you", tone: "ask" },
  { from: "att-you", to: "att-answered", label: "you answer", tone: "work" },
  { from: "backlog-new", to: "dropped", label: "orc backlog drop", tone: "work" },
  { from: "kind-decision", to: "answered", tone: "work" },
  { from: "run", to: "stopped", label: "orc backlog stop", tone: "work" },
  { from: "checks", to: "failed", label: "red after three fixes", tone: "work" },
  { from: "checks", to: "report", tone: "work" },
  { from: "checks", to: "pull-request", tone: "work" },
  { from: "merge", to: "pull-request", tone: "work" }
]

export const childrenOf = (id: string | undefined): readonly MapPart[] => parts.filter((part) => part.inside === id)

export const folds = (id: string): boolean => parts.some((part) => part.inside === id)

const byId = new Map(parts.map((part) => [part.id, part]))

// The nearest part on screen: a part hidden inside a folded one stands as that folded part.
export const shownAs = (id: string, open: ReadonlySet<string>): string => {
  const chain: string[] = []
  for (let part = byId.get(id); part !== undefined; part = part.inside === undefined ? undefined : byId.get(part.inside)) chain.unshift(part.id)
  const firstFolded = chain.findIndex((step, index) => index < chain.length - 1 && !open.has(step))
  return firstFolded === -1 ? id : (chain[firstFolded] ?? id)
}

export const shownLinks = (open: ReadonlySet<string>): readonly MapLink[] => {
  const seen = new Set<string>()
  return links.flatMap((link) => {
    const from = shownAs(link.from, open)
    const to = shownAs(link.to, open)
    const key = from + ">" + to
    if (from === to || seen.has(key)) return []
    seen.add(key)
    const lifted = from !== link.from || to !== link.to
    return [{ from, to, tone: link.tone, ...(lifted || link.label === undefined ? {} : { label: link.label }) }]
  })
}

export const shownParts = (open: ReadonlySet<string>): readonly MapPart[] => parts.filter((part) => shownAs(part.id, open) === part.id)
