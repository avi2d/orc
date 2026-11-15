interface NeverDecided {
  readonly topic: string
  readonly asks: RegExp
}

const deletingVerbs = "delet\\w*|remov\\w*|drop\\w*|discard\\w*|eras(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|purg\\w*|destroy\\w*|prun\\w*|abandon\\w*|overwrit\\w*|reset\\w*|(?:throw|throws|throwing|threw|thrown) away|clean(?:s|ed|ing)? up|rm"
const deletedVerbs = "deleted|removed|dropped|discarded|erased|wiped|purged|destroyed|pruned|abandoned|overwritten|reset|thrown away|cleaned up"
const work = "branch(?:es)?|commits?|worktrees?|stash(?:es)?|work|history|tags?|repos?|repositor(?:y|ies)|databases?|backups?|checkouts?|(?:uncommitted|unlanded|unmerged|unpushed|unsaved|local) changes"
const notAName = "(?!\\s+(?:check|name|field|filter|guard|test|option|flag|column|label|chip|key|type|lookup|variable|param\\w*|prop\\w*|argument)s?\\b)"
const between = "(?:\\s+(?!(?:on|in|of|for|from|to|at|by|with|that|which|so|and|or|but|if|when|because|then|than|while)\\b)[\\w./`'-]+){0,3}?"

// A deleting question names the work it deletes, so a verb alone, as in "removing the fallback", or a name, as in "drop the branch check", does not make one.
const deletingWork = new RegExp(
  "\\b(?:" + deletingVerbs + ")" + between + "\\s+(?:" + work + ")\\b" + notAName
    + "|\\b(?:" + work + ")\\b(?:\\s+\\w+){0,3}?\\s+(?:" + deletedVerbs + ")\\b"
    + "|\\brm\\s+-\\w*[rf]|\\breset\\s+--hard|\\bbranch\\s+-D\\b|\\bclean\\s+-\\w*f",
  "i"
)

// Neither the written rules nor the policy reach this list, so no prompt can widen what the decider answers.
const neverDecided: ReadonlyArray<NeverDecided> = [
  { topic: "deleting", asks: deletingWork },
  { topic: "security", asks: /\b(secur\w*|insecur\w*|vulnerab\w*|exploit\w*)\b/i },
  {
    topic: "credentials",
    asks: /\b(credentials?|secrets?|passwords?|passphrases?|(?<!(?:design|lexer|parser|syntax|cancellation|css|input|output|prompt) )tokens?|(?:api|ssh|gpg|pgp|private|public|secret|access|deploy|signing|encryption|license|licence)[- ]keys?|keychains?|key ?files?|key ?pairs?)\b/i
  },
  { topic: "merging", asks: /\bmerg\w*/i },
  { topic: "pushing", asks: /\bpush\w*\b/i },
  { topic: "releasing", asks: /\b(releas\w*|publish\w*|deploy\w*)/i },
  { topic: "spending", asks: /\b(spend\w*|spent|pay|pays|paying|paid|payments?|costs?|costing|billing|purchas\w*|buy\w*|budget\w*)\b/i },
  { topic: "anything that cannot be undone", asks: /\b(irreversib\w*|irrevocab\w*|permanent\w*|undoable|(cannot|can't|can not) be (undone|reversed)|force[- ]push\w*)/i },
  { topic: "a site's look", asks: /\b((look|looks|looking)\b(?!\s+(up|for|like|at|into|through|after)\b)|appearance|visual\w*|screenshots?|previews?)\b/i },
  { topic: "legal text", asks: /\b(legal\w*|laws?|privacy polic(y|ies)|terms of use|consent\w*|offers?)\b/i },
  { topic: "logins", asks: /\b(log-?ins?|log in|sign[- ]in|auth|authn|authz|authenticat\w*|authoriz\w*|oauth\w*)\b/i }
]

export const neverDecidedReason = (question: string): string | null => {
  for (const entry of neverDecided) {
    const found = entry.asks.exec(question)
    if (found !== null) {
      return "orc never hands the decider a question about " + entry.topic + ", and this one says " + JSON.stringify(found[0])
    }
  }
  return null
}

export const askBackWords = (question: string): string =>
  "Before it answers, orc's decider asks you: " + question + "\nPut your reply in a new orc_ask question."
