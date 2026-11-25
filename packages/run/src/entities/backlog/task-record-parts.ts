type StateKind =
  | { readonly kind: "new" | "taken" | "started" }
  | { readonly kind: "closed"; readonly closing: { readonly outcome: string } }

export const fence = "---"

export const splitFrontmatter = (text: string): { readonly head: string; readonly body: string } | null => {
  if (!text.startsWith(fence + "\n")) {
    return null
  }
  const end = text.indexOf("\n" + fence + "\n", fence.length)
  if (end === -1) {
    return null
  }
  return { head: text.slice(fence.length + 1, end + 1), body: text.slice(end + fence.length + 2) }
}

export const heldWhileActive = (hold: { readonly answer: unknown } | null, state: { readonly kind: string }): boolean =>
  hold !== null && hold.answer === null && (state.kind === "started" || state.kind === "closed")

export const closedWithUnansweredQuestion = (parked: { readonly questions: ReadonlyArray<{ readonly answer: unknown }> } | null, state: StateKind): boolean =>
  state.kind === "closed" && state.closing.outcome !== "start-failed" && parked?.questions.some((question) => question.answer === null) === true

export const priorPrOf = (pr: string | undefined, state: StateKind): { readonly priorPr?: string } =>
  pr === undefined || (state.kind === "closed" && state.closing.outcome !== "start-failed") ? {} : { priorPr: pr }
