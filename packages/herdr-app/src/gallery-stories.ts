import type { CardStatus } from "./agents"
import type { AlertShown, ButtonLook, CheckState, ControlSize, Vendor } from "./kit"
import type { AskOption, Thread, ThreadCard, ThreadLine } from "./thread"

type AlertExample = Omit<AlertShown, "actions"> & { readonly actions?: ReadonlyArray<string> }

type GalleryRow =
  | { readonly kind: "group"; readonly key: string; readonly label: string }
  | { readonly kind: "run"; readonly key: string; readonly label: string; readonly status: CardStatus }

type ThreadReply =
  | { readonly kind: "read-only" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: string }

type Example =
  | { readonly component: "button"; readonly look: ButtonLook; readonly size: ControlSize; readonly disabled: boolean }
  | { readonly component: "field"; readonly size: ControlSize; readonly value: string }
  | { readonly component: "fieldWithButton"; readonly value: string; readonly action: "send" | "sending" }
  | { readonly component: "selectTrigger"; readonly size: ControlSize; readonly value: string }
  | { readonly component: "card"; readonly body: string }
  | { readonly component: "tab"; readonly active: boolean; readonly disabled: boolean }
  | { readonly component: "kbd"; readonly key: string }
  | { readonly component: "radio"; readonly checked: boolean }
  | { readonly component: "statusDot"; readonly status: CardStatus }
  | { readonly component: "checkIcon"; readonly state: CheckState }
  | { readonly component: "vendorLogo"; readonly vendor: Vendor | null }
  | { readonly component: "alert"; readonly shown: AlertExample }
  | { readonly component: "uniformRows"; readonly rows: ReadonlyArray<GalleryRow> }
  | { readonly component: "linkedText"; readonly text: string }
  | { readonly component: "threadEntry"; readonly card: ThreadCard; readonly reply: ThreadReply }
  | { readonly component: "threadDecided"; readonly thread: Thread }

export type GalleryStory = Example & { readonly id: string; readonly label: string }

const sizes = [24, 32] as const
const looks = ["primary", "secondary", "ghost"] as const
const buttonStories = sizes.flatMap((size) => looks.flatMap((look) => ([false, true] as const).map((disabled) => ({
  id: `button.${size}.${look}.${disabled ? "disabled" : "enabled"}`,
  label: `${size} px ${look}${disabled ? ", disabled" : ""}`,
  component: "button" as const,
  size, look, disabled
}))))

const longProject = "orchard-runner-with-a-long-project-name"
const longLink = "https://example.invalid/garden/orchard-runner-with-a-long-project-name/pull/42"
const answer = "Use the native gallery."
const optionExamples = [
  { letter: "A", text: "Open the gallery in Herdr.", picture: null },
  { letter: "B", text: "Review a native screenshot.", picture: "gallery-preview-missing.png" }
] as const satisfies ReadonlyArray<AskOption>

const entry = (who: ThreadLine["who"], kind: ThreadLine["kind"], text: string): ThreadLine =>
  ({ who, kind, text, at: null, id: "garden-42.gallery.asked" })

const card = (key: string, line: ThreadLine, what: string): ThreadCard => ({
  key, line, what, ask: null, answers: [], delivered: false, notes: [], reply: null, waitsOn: []
})

const question = {
  ...card("gallery-question", entry("worker", "question", "Which gallery should open first?"), "Question"),
  ask: { question: "Which gallery should open first?", context: "The sample runs without live tasks.", options: optionExamples }
} satisfies ThreadCard

const reply = entry("user", "answer", answer)

const runs: ReadonlyArray<GalleryRow> = [
  { kind: "group", key: "attention", label: "Awaiting you" },
  { kind: "run", key: "garden", label: "Compare colours on Paper", status: "Awaiting you" },
  { kind: "group", key: "active", label: "Running" },
  ...Array.from({ length: 24 }, (_, index) => ({
    kind: "run" as const, key: `run-${index + 1}`, label: `Check the wide layout, run ${index + 1}`, status: "Running" as const
  }))
]

export const galleryStories: ReadonlyArray<GalleryStory> = [
  ...buttonStories,
  { id: "field.24.empty", label: "24 px empty", component: "field", size: 24, value: "" },
  { id: "field.24.typed", label: "24 px typed", component: "field", size: 24, value: "Garden" },
  { id: "field.32.empty", label: "32 px empty", component: "field", size: 32, value: "" },
  { id: "field.32.typed", label: "32 px typed", component: "field", size: 32, value: "Garden" },
  { id: "field-with-button.empty", label: "Empty answer", component: "fieldWithButton", value: "", action: "send" },
  { id: "field-with-button.ready", label: "Answer ready to send", component: "fieldWithButton", value: answer, action: "send" },
  { id: "field-with-button.sending", label: "Sending an answer", component: "fieldWithButton", value: answer, action: "sending" },
  { id: "select-trigger.24", label: "24 px project select", component: "selectTrigger", size: 24, value: "All projects" },
  { id: "select-trigger.32.long", label: "32 px long project name", component: "selectTrigger", size: 32, value: longProject },
  { id: "card.inbox", label: "Inbox surface", component: "card", body: "Where should the gallery live?" },
  { id: "tab.active", label: "Active", component: "tab", active: true, disabled: false },
  { id: "tab.inactive", label: "Inactive", component: "tab", active: false, disabled: false },
  { id: "tab.disabled", label: "Disabled", component: "tab", active: false, disabled: true },
  { id: "tab.active-disabled", label: "Active and disabled", component: "tab", active: true, disabled: true },
  { id: "kbd.single", label: "Single key", component: "kbd", key: "1" },
  { id: "kbd.long", label: "Long key", component: "kbd", key: "Esc" },
  { id: "radio.unchecked", label: "Unchecked", component: "radio", checked: false },
  { id: "radio.checked", label: "Checked", component: "radio", checked: true },
  { id: "status-dot.awaiting", label: "Awaiting you", component: "statusDot", status: "Awaiting you" },
  { id: "status-dot.running", label: "Running", component: "statusDot", status: "Running" },
  { id: "status-dot.queued", label: "Queued", component: "statusDot", status: "Queued" },
  { id: "status-dot.failed", label: "Failed", component: "statusDot", status: "Failed" },
  { id: "status-dot.done", label: "Done", component: "statusDot", status: "Done" },
  { id: "check-icon.running", label: "Running", component: "checkIcon", state: "running" },
  { id: "check-icon.passed", label: "Passed", component: "checkIcon", state: "passed" },
  { id: "check-icon.failed", label: "Failed", component: "checkIcon", state: "failed" },
  { id: "vendor-logo.claude", label: "Claude", component: "vendorLogo", vendor: "claude" },
  { id: "vendor-logo.openai", label: "OpenAI", component: "vendorLogo", vendor: "openai" },
  { id: "vendor-logo.empty", label: "No vendor", component: "vendorLogo", vendor: null },
  { id: "alert.neutral", label: "Title only", component: "alert", shown: { tone: "neutral", title: "No matching runs" } },
  { id: "alert.info", label: "Waiting for data", component: "alert", shown: { tone: "info", title: "Reading the runs", body: "Waiting for the run list." } },
  { id: "alert.warning", label: "Several actions", component: "alert", shown: { tone: "warning", title: "Run needs review", body: "The last read may be out of date.", actions: ["Dismiss", "Check"] } },
  { id: "alert.error", label: "One action", component: "alert", shown: { tone: "error", title: "Could not read the runs", body: "The request failed.", actions: ["Retry"] } },
  { id: "alert.success", label: "Confirmation", component: "alert", shown: { tone: "success", title: "Answer recorded" } },
  { id: "rows.grouped", label: "Scrollable grouped runs", component: "uniformRows", rows: runs },
  { id: "rows.empty", label: "No list rows", component: "uniformRows", rows: [] },
  { id: "linked-text.plain", label: "Without a link", component: "linkedText", text: "The run passed." },
  { id: "linked-text.wrapped", label: "Long link with punctuation", component: "linkedText", text: `Read ${longLink}: the checks passed.\nSee the next line for the result.` },
  { id: "thread.note", label: "Plain activity", component: "threadEntry", card: card("gallery-note", entry("worker", "note", "The light surface is ready to review."), "Note"), reply: { kind: "read-only" } },
  { id: "thread.hold", label: "Waiting to answer", component: "threadEntry", card: { ...card("gallery-hold", entry("worker", "hold", "Waiting to compare light and dark."), "Hold"), waitsOn: ["garden-43"] }, reply: { kind: "read-only" } },
  { id: "thread.question", label: "Open question and options", component: "threadEntry", card: question, reply: { kind: "ready" } },
  { id: "thread.reply-failed", label: "Failed reply", component: "threadEntry", card: question, reply: { kind: "failed", reason: "Could not send the sample answer." } },
  { id: "thread.delivered", label: "Delivered answer and follow-up", component: "threadEntry", card: { ...question, answers: [reply], delivered: true, notes: [entry("worker", "note", "The example is ready.")] }, reply: { kind: "read-only" } },
  { id: "thread.withdrawn", label: "Withdrawn question", component: "threadEntry", card: { ...question, notes: [entry("worker", "withdrawn", "The question no longer needs an answer.")] }, reply: { kind: "read-only" } },
  { id: "thread.decisions", label: "Owner and agent decisions", component: "threadDecided", thread: {
    task: "garden-42", entries: [reply, entry("decider", "decision", "The sample must leave real tasks alone."), entry("decider", "answer", "Use fixture data.")]
  } }
]
