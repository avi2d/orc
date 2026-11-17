type Tone = "ask" | "ok" | "end"

type LinkTone = "work" | "aside" | "ask"

export const blockMeanings = {
  plain: "A part of orc, or one step",
  ask: "A question or news waits here, or gets its answer",
  ok: "A task ends with a result",
  end: "A task ends without a result",
  area: "A group, around the parts inside it"
} satisfies Record<Tone | "plain" | "area", string>

export const arrowMeanings = {
  work: "The main path, from one step to the next",
  aside: "A side path: a wait, a step back or a stop",
  ask: "A question or news on its way, and the answer back"
} satisfies Record<LinkTone, string>

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

export interface ShownLink {
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly tone: LinkTone
}

export interface MapLink extends ShownLink {
  readonly side?: true
}

export const mapTitle = "How orc works"

// A part with inner parts takes no link of its own: a link names the innermost part it touches.
export const parts: readonly MapPart[] = [
  { id: "you", title: "You" },
  { id: "plans", title: "The machine that plans" },
  { id: "works", title: "A machine that works" },
  { id: "ends", title: "How a task ends" },

  { id: "chat", inside: "you", title: "The chat", text: "Say the work. Answer questions.", page: "concepts/chat" },
  { id: "chat-say", inside: "chat", title: "You say", points: ["the work, in plain words", "an answer to a question", "to merge a pull request"] },
  { id: "chat-model", inside: "chat", title: "The orchestrator model", text: "A Pi session with eight tools and no others. It can change the backlog and nothing else." },
  {
    id: "chat-tools",
    inside: "chat",
    title: "Eight tools, each an orc command",
    points: ["four shape the backlog: add, edit, priority and hold", "three read it and answer its questions", "one merges a pull request"]
  },
  {
    id: "chat-posts",
    inside: "chat",
    title: "It posts what changed",
    text: "It reads the backlog every 15 seconds.",
    points: ["a task that closed, with its outcome", "a question that waits on you", "a stalled run", "a pull request that turned green or merged"]
  },

  { id: "app", inside: "you", title: "The app and the dashboard", text: "Show it all. Hold no state.", page: "concepts/app" },
  { id: "app-state", inside: "app", title: "The state", text: "Files in ~/.orc, and the pueue queues." },
  { id: "app-commands", inside: "app", title: "The orc commands", text: "Both screens run them and draw what they print, so a screen and the command line never disagree." },
  { id: "app-herdr", inside: "app", title: "The Herdr App", points: ["Board: the backlog as cards in five lanes", "Agents: the runs, step by step", "Resources: quota and machines", "a chat drawer on every tab"] },
  { id: "app-dash", mono: true, inside: "app", title: "orc-dash", text: "The same facts as panels in a terminal. The chat's alerts come from its alert stream." },

  { id: "backlog", inside: "plans", title: "The backlog", text: "One file per task, in priority order.", page: "concepts/backlog" },
  {
    id: "backlog-new",
    mono: true,
    inside: "backlog",
    title: "new",
    text: "Waiting to start, in priority order. It waits while:",
    points: ["it has no priority", "you hold it", "a question has no answer", "it depends on an open task", "no machine has a free slot", "no account has room"]
  },
  { id: "backlog-taken", mono: true, inside: "backlog", title: "taken", text: "A beat took it. Its run is queued or running on a machine." },
  {
    id: "backlog-closed",
    mono: true,
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

  { id: "quota", inside: "plans", title: "Quota", text: "Room left on each account.", page: "concepts/accounts-and-quota" },
  { id: "quota-config", mono: true, inside: "quota", title: "dispatch.json", text: "You name the accounts, the floor and the quota command once." },
  { id: "quota-command", inside: "quota", title: "The quota command", text: "Each beat runs it first. It prints the room left on each account." },
  { id: "quota-read", inside: "quota", title: "Did the beat read it?", text: "Not when the command fails, runs past 15 seconds or prints anything else." },
  { id: "quota-nothing", inside: "quota", title: "This beat starts nothing" },
  { id: "quota-usable", inside: "quota", title: "Which accounts can run?", points: ["named in what the command printed", "room above 0%", "at or above the floor, when you set one"] },
  { id: "quota-most", inside: "quota", title: "The one with the most room", text: "Every task this beat starts takes it." },

  { id: "beat", inside: "plans", title: "The beat", text: "Every few minutes, starts what can start.", page: "concepts/beat" },
  { id: "beat-clock", inside: "beat", title: "Runs on a clock", text: "Cron or launchd runs orc beat every few minutes. Orc has no daemon." },
  {
    id: "beat-holds",
    inside: "beat",
    title: "Do all five hold?",
    points: ["the task has a priority", "no hold, and no question without an answer", "each task it depends on is done", "a machine with the checkout has a free slot", "an account has room"]
  },
  { id: "beat-waits", inside: "beat", title: "It waits for the next beat", text: "The beat prints the reason. A decision never starts." },
  { id: "beat-starts", inside: "beat", title: "It starts", text: "The beat takes the task and runs the machine's start command." },
  {
    id: "beat-also",
    inside: "beat",
    title: "Every beat also",
    points: ["closes the runs that ended", "parks a task whose run stopped on a question", "resumes it once you answer", "carries questions and answers", "flags a run silent for 30 minutes"]
  },

  { id: "attention", inside: "plans", title: "The attention queue", tone: "ask", text: "Every open question waits here.", page: "concepts/attention" },
  { id: "att-question", inside: "attention", title: "A question from a run", tone: "ask", text: "The worker, fixer, or review can ask. A worker question can block or leave the run working." },
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
  { id: "att-answered", inside: "attention", title: "Answered", text: "The run carries on where it waited." },

  { id: "decider", inside: "plans", title: "The decider", tone: "ask", text: "A model answers routine questions from written instructions, or asks you.", page: "concepts/attention" },
  { id: "dec-reads", inside: "decider", title: "What it reads", tone: "ask", text: "Your rules, the project instructions, the task, and earlier answers. It has no tools." },
  { id: "dec-quote", inside: "decider", title: "Can it answer?", tone: "ask", text: "It can quote a rule, the task or its policy, reuse an earlier answer, or ask the worker for more detail." },

  { id: "runner", inside: "works", title: "The runner", text: "A queue on the machine, a few tasks at a time.", page: "concepts/runner" },
  { id: "runner-start", mono: true, inside: "runner", title: "orc runner start", text: "Reads the task and queues the run. The beat never waits for it." },
  { id: "runner-far", inside: "runner", title: "Another machine", text: "The task travels over SSH to orc runner queue there." },
  { id: "runner-queue", inside: "runner", title: "The queue", text: "The pueue group orc. One slot per running task, and a full machine holds the task back." },
  { id: "runner-heavy", inside: "runner", title: "One heavy slot", text: "The test runs and builds of every agent take turns, so they cannot overload the machine." },
  { id: "runner-reach", inside: "runner", title: "A later beat asks the runner", points: ["the state of the run", "to hand it your answers", "to stop it"] },

  { id: "run", inside: "works", title: "A run", text: "Pi works on the task. A ship task gets its own branch and worktree.", page: "concepts/run" },
  { id: "run-copy", inside: "run", title: "A copy for a ship task", text: "A git worktree on a new branch. Your own checkout is never touched." },
  { id: "run-prepare", inside: "run", title: "Prepare a ship task", text: "The project's prepare command, such as an install." },
  { id: "run-pi", inside: "run", title: "Pi works", text: "The agent commits a change or writes a report, according to the task kind." },
  {
    id: "run-watch",
    inside: "run",
    title: "Orc watches Pi",
    tone: "ask",
    points: ["idle for 45 minutes by default, with no tool running: orc stops it", "one command fails 3 times in a row: you are told", "it fails 6 times in a row: orc pauses and asks", "Pi is unsure: it asks instead of guessing"]
  },
  { id: "run-record", inside: "run", title: "The record", text: "The task, the logs and the report, under ~/.orc/runs. A resumed run skips the steps that passed." },

  { id: "checks", inside: "works", title: "Checks and review", text: "The agent fixes failed checks. Most code changes also go through no-mistakes.", page: "concepts/checks-and-review" },
  { id: "chk-gate", inside: "checks", title: "The checks", text: "The commands the project names in .no-mistakes.yaml." },
  { id: "chk-fixer", inside: "checks", title: "A fixer", text: "A second Pi gets the failing output and repairs it. Then the checks run again." },
  { id: "chk-review", inside: "checks", title: "The review", text: "When configured, no-mistakes reads the branch with the task as its intent." },
  { id: "chk-findings", inside: "checks", title: "What orc does with a finding", points: ["auto-fix: asks no-mistakes to fix it", "no-op: ignores it", "ask-user: a question that waits"] },
  { id: "chk-wait", inside: "checks", title: "A question waits at the gate", tone: "ask", text: "By default, for 30 minutes. With no answer the task parks on its branch, and resumes on an answer." },
  { id: "chk-deliver", inside: "checks", title: "Deliver", text: "A code change is pushed and gets a pull request. Report tasks follow a separate path." },

  { id: "dropped", inside: "ends", title: "Dropped", tone: "end", text: "Before it started, with orc backlog drop." },
  { id: "answered", inside: "ends", title: "Answered", tone: "end", text: "A decision never runs. Your answer closes it." },
  { id: "stopped", inside: "ends", title: "Stopped", tone: "end", text: "You stopped the run." },
  { id: "failed", inside: "ends", title: "Failed", tone: "end", text: "It could not start, it died, or its checks stayed red." },
  { id: "report", inside: "ends", title: "A report", tone: "ok", text: "A scout or task run ends with a report, not a pull request." },
  { id: "pull-request", inside: "ends", title: "A pull request", tone: "ok", text: "A code change, checked before it reaches you. Delivery may include review." },
  { id: "merge", mono: true, inside: "ends", title: "orc merge", text: "You land the pull request once CI is green.", page: "concepts/merge" },
  { id: "merge-ask", inside: "merge", title: "Who asks", points: ["you, with orc merge", "the chat, with its merge tool", "the app, with its Approve step"] },
  { id: "merge-holds", inside: "merge", title: "Do all four hold?", points: ["the task names a pull request", "it is open", "every check reported green", "the branch is not behind its base"] },
  { id: "merge-refused", inside: "merge", title: "Refused: nothing merges", text: "The refusal names every reason." },
  { id: "merge-done", inside: "merge", title: "Squash merge", tone: "ok", text: "At the exact commit it checked." },
  { id: "merge-word", inside: "merge", title: "Whose word merges", text: "Yours. The decider answers no question about merging." }
]

// A label has to read true from the folded part too, because a folded part keeps the labels of its inner parts.
export const links: readonly MapLink[] = [
  { from: "chat-say", to: "chat-model", tone: "work" },
  { from: "chat-model", to: "chat-tools", tone: "work" },
  { from: "chat-tools", to: "backlog-new", label: "add a task", tone: "work" },
  { from: "app-state", to: "app-commands", tone: "work" },
  { from: "app-commands", to: "app-herdr", tone: "work" },
  { from: "app-commands", to: "app-dash", tone: "work" },

  { from: "backlog-new", to: "backlog-taken", label: "a beat takes it", tone: "work" },
  { from: "backlog-taken", to: "backlog-closed", label: "the run ends", tone: "work" },
  { from: "backlog-taken", to: "backlog-new", label: "its run stops on a question", tone: "ask" },
  { from: "backlog-closed", to: "backlog-new", label: "orc backlog send-back", tone: "aside" },
  { from: "backlog-new", to: "beat-holds", tone: "work" },

  { from: "quota-config", to: "quota-command", tone: "work" },
  { from: "quota-command", to: "quota-read", tone: "work" },
  { from: "quota-read", to: "quota-nothing", label: "no", tone: "aside" },
  { from: "quota-read", to: "quota-usable", label: "yes", tone: "work" },
  { from: "quota-usable", to: "quota-most", tone: "work" },
  { from: "quota-most", to: "beat-holds", tone: "work" },

  { from: "beat-clock", to: "beat-holds", tone: "work" },
  { from: "beat-holds", to: "beat-starts", label: "yes", tone: "work" },
  { from: "beat-holds", to: "beat-waits", label: "no", tone: "aside" },
  { from: "beat-starts", to: "runner-start", label: "starts a task", tone: "work" },

  { from: "runner-start", to: "runner-queue", tone: "work" },
  { from: "runner-start", to: "runner-far", tone: "work" },
  { from: "runner-far", to: "runner-queue", tone: "work" },
  { from: "runner-queue", to: "run-copy", tone: "work" },

  { from: "run-copy", to: "run-prepare", tone: "work" },
  { from: "run-prepare", to: "run-pi", tone: "work" },
  { from: "run-pi", to: "chk-gate", tone: "work" },
  { from: "run-pi", to: "att-question", label: "a question", tone: "ask" },

  { from: "chk-gate", to: "chk-fixer", label: "red", tone: "aside" },
  { from: "chk-fixer", to: "chk-gate", label: "again", tone: "aside" },
  { from: "chk-fixer", to: "att-question", label: "a question", tone: "ask" },
  { from: "chk-gate", to: "chk-review", label: "green", tone: "work" },
  { from: "chk-gate", to: "chk-deliver", label: "direct PR", tone: "work" },
  { from: "chk-review", to: "chk-findings", tone: "work" },
  { from: "chk-findings", to: "chk-wait", label: "ask-user", tone: "ask" },
  { from: "chk-findings", to: "chk-deliver", tone: "work" },
  { from: "chk-wait", to: "att-question", label: "a question", tone: "ask" },

  { from: "att-question", to: "att-guarded", tone: "ask" },
  { from: "att-guarded", to: "att-you", label: "yes", tone: "ask" },
  { from: "att-guarded", to: "dec-reads", label: "a routine question", tone: "ask" },
  { from: "dec-reads", to: "dec-quote", tone: "ask" },
  { from: "dec-quote", to: "att-answered", label: "its answer", tone: "ask" },
  { from: "dec-quote", to: "att-you", label: "it cannot answer", tone: "ask", side: true },
  { from: "att-news", to: "att-you", tone: "ask" },
  { from: "att-you", to: "chat-posts", label: "the rest wait for you", tone: "ask", side: true },
  { from: "att-you", to: "att-answered", label: "you answer", tone: "ask" },

  { from: "run-pi", to: "stopped", label: "orc backlog stop", tone: "aside" },
  { from: "chk-fixer", to: "failed", label: "red after three fixes", tone: "aside" },
  { from: "run-pi", to: "report", label: "report task", tone: "work" },
  { from: "chk-deliver", to: "pull-request", tone: "work" },
  { from: "pull-request", to: "merge-ask", tone: "work" },
  { from: "merge-ask", to: "merge-holds", tone: "work" },
  { from: "merge-holds", to: "merge-done", label: "yes", tone: "work" },
  { from: "merge-holds", to: "merge-refused", label: "no", tone: "aside" }
]

export const childrenOf = (id: string | undefined): readonly MapPart[] => parts.filter((part) => part.inside === id)

export const folds = (id: string): boolean => parts.some((part) => part.inside === id)

const byId = new Map(parts.map((part) => [part.id, part]))

export const pathTo = (id: string): readonly string[] => {
  const chain: string[] = []
  for (let part = byId.get(id); part !== undefined; part = part.inside === undefined ? undefined : byId.get(part.inside)) chain.unshift(part.id)
  return chain
}

// The nearest part on screen: a part hidden inside a folded one stands as that folded part.
const shownAs = (id: string, open: ReadonlySet<string>): string => {
  const chain = pathTo(id)
  const firstFolded = chain.findIndex((step, index) => index < chain.length - 1 && !open.has(step))
  return firstFolded === -1 ? id : (chain[firstFolded] ?? id)
}

export const shownLinks = (open: ReadonlySet<string>): readonly ShownLink[] => {
  const seen = new Set<string>()
  return links.flatMap((link) => {
    const from = shownAs(link.from, open)
    const to = shownAs(link.to, open)
    const key = from + ">" + to
    if (from === to || seen.has(key) || (link.side === true && from !== link.from)) return []
    seen.add(key)
    return [{ from, to, tone: link.tone, ...(link.label === undefined ? {} : { label: link.label }) }]
  })
}

export const titleOf = (id: string): string => byId.get(id)?.title ?? id
