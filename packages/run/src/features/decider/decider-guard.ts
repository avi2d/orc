interface NeverDecided {
  readonly topic: string
  readonly asks: RegExp
  readonly about?: RegExp
}

const deletingVerbs = "delet\\w*|remov\\w*|drop\\w*|discard\\w*|eras(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|purg\\w*|destroy\\w*|prun\\w*|abandon\\w*|overwrit\\w*|reset\\w*|(?:throw|throws|throwing|threw|thrown) away|clean(?:s|ed|ing)? up|start(?:s|ed|ing)? over|(?:throw|throws|throwing|threw|thrown) out|revert\\w*|restor(?:e|es|ed|ing)|rm"
const deletedVerbs = "deleted|removed|dropped|discarded|erased|wiped|purged|destroyed|pruned|abandoned|overwritten|reset|thrown away|cleaned up"
const work = "branch(?:es)?|worktrees?|tasks?|(?<!\\btest\\s)runs?|pull requests?|releases?|tags?|backups?|databases?|user data|commit history|(?:unlanded|unmerged|unpushed) (?:work|changes|commits)"
const notAName = "(?!\\s+(?:check|name|field|filter|guard|test|option|flag|column|label|chip|key|type|lookup|variable|param\\w*|prop\\w*|argument|list|support|fallback|handling)s?\\b)"
const ownWork = "commits?|changes|edits|work|stash(?:es)?|modifications?|diffs?"
const joiningWords = "on|in|of|for|from|to|at|by|with|that|which|so|and|or|but|if|when|because|then|than|while"
const between = "(?:\\s+(?!(?:" + joiningWords + ")\\b)[\\w./`'-]+){0,3}?"

const computeMeasure = "time|times|timing|loops?|cpu|memory|ram|performance|runtime|latency|complexity|allocations?|iterations?|cycles?|speed|startup|overhead"

const deletingWork = new RegExp(
  "\\b(?:" + deletingVerbs + ")" + between + "\\s+(?:" + work + ")\\b" + notAName
    + "|\\b(?:" + work + ")\\b(?:\\s+\\w+){0,3}?\\s+(?:" + deletedVerbs + ")\\b"
    + "|\\b(?:" + deletingVerbs + ")" + between + "\\s+[a-z][a-z0-9]*-\\d+\\b" + notAName
    + "|\\b(?:" + deletingVerbs + ")" + between + "\\s+(?:" + ownWork + ")\\b"
    + "|\\breset\\s+--hard|\\bbranch\\s+-D\\b|\\bstash\\s+(?:drop|clear)\\b|\\bclean\\s+-\\w*f|\\bcheckout\\s+--\\s+\\.|\\brestore\\s+\\.",
  "i"
)

const deletingVerb = new RegExp("\\b(?:" + deletingVerbs + ")\\b", "i")

const namesUnlandedWork = /\b(?:unlanded|unmerged|unpushed|unfinished|uncommitted)\b/i

const neverDecided: ReadonlyArray<NeverDecided> = [
  { topic: "deleting", asks: deletingWork },
  { topic: "deleting", asks: deletingVerb, about: namesUnlandedWork },
  { topic: "security", asks: /\b(secur\w*|insecur\w*|vulnerab\w*|exploit\w*)\b/i },
  {
    topic: "credentials",
    asks: /\b(credentials?|secrets?|passwords?|passphrases?|(?:api|ssh|gpg|pgp|private|public|secret|access|deploy|signing|encryption|license|licence|session|openai|anthropic|github|gitlab|stripe|aws|npm|slack|google|cloudflare)[- ](?:keys?|tokens?)|keychains?|key ?files?|key ?pairs?)\b|\b(?:rotate|revoke|leak|regenerate)\w*\s+(?:the\s+)?(?:keys?|tokens?)\b|(?<![\w])\.env\b/i
  },
  { topic: "credentials", asks: /\b[A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET)\b/ },
  { topic: "merging", asks: /\bmerg\w*/i },
  { topic: "pushing", asks: /\bpush\w*\b/i },
  { topic: "releasing", asks: /\b(releas\w*|publish\w*|deploy\w*)/i },
  { topic: "spending", asks: /\b(pay|pays|paying|paid|payments?|billing|purchas\w*|buy\w*|budget\w*|money|dollars?)\b|\$\s?\d+/i },
  { topic: "spending", asks: new RegExp("(?<!\\b(?:" + computeMeasure + ")\\b[^.?!]*)\\b(?:spend\\w*|spent|costs?|costing)\\b(?![^.?!]*\\b(?:" + computeMeasure + ")\\b)", "i") },
  { topic: "anything that cannot be undone", asks: /\b(irreversib\w*|irrevocab\w*|permanent\w*|undoable|(cannot|can't|can not) be (undone|reversed)|force[- ]push\w*)/i },
  { topic: "a site's look", asks: /\b(look|looks|looking)\b(?!\s+(?:up|for|into|through|over|out|after|ahead|back|forward)\b)|\b(appearance|visual\w*|screenshots?|previews?)\b/i },
  { topic: "legal text", asks: /\blegal\w*\b(?!\s+(?:value|move|state|input|character|identifier|name|token)s?\b)|(?<!['’]s\s)\blaws?\b(?!\s+of\b)|\b(privacy polic(y|ies)|terms of (?:use|service)|consent\w*|public offers?|offer agreements?)\b/i },
  { topic: "logins", asks: /\b(log-?ins?|log in|sign[- ]in|auth|authn|authz|authenticat\w*|authoriz\w*|oauth\w*)\b(?!\s+(?:header|fixture|test|mock|stub|helper|type)s?\b)/i }
]

export const neverDecidedReason = (question: string): string | null => {
  for (const entry of neverDecided) {
    const found = entry.asks.exec(question)
    if (found !== null && (entry.about === undefined || entry.about.test(question))) {
      return "orc never hands the decider a question about " + entry.topic + ", and this one says " + JSON.stringify(found[0])
    }
  }
  return null
}

const routineAction = "none"

const actionWords: ReadonlyMap<string, string> = new Map([["merge", "merge"], ["delete", "delete unlanded work"], ["login", "log in"], ["push", "push"], ["release", "release"]])

const askedActionReason = (asks: string): string | null => {
  if (asks === routineAction) {
    return null
  }
  const named = actionWords.get(asks)
  return named === undefined
    ? "the review question asks the owner for the action " + JSON.stringify(asks) + ", which orc does not know, so orc hands it to the owner"
    : "the review question asks the owner to " + named + ", and orc hands every asked action to the owner"
}

const unclassified = "unknown"

const textReason = (text: string): string | null =>
  text.trim() === "" ? "the question carries no words orc can check, so orc hands it to the owner" : neverDecidedReason(text)

export const guardReason = (question: { readonly text: string; readonly asks?: string | undefined }): string | null =>
  question.asks === undefined || question.asks === unclassified ? textReason(question.text) : askedActionReason(question.asks)

export const askBackWords = (question: string): string =>
  "Before it answers, orc's decider asks you: " + question + "\nPut your reply in a new orc_ask question."
