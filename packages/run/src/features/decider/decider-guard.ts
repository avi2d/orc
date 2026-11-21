interface NeverDecided {
  readonly topic: string
  readonly words: RegExp
}

// Neither the written rules nor the policy reach this list, so no prompt can widen what the decider answers.
const neverDecided: ReadonlyArray<NeverDecided> = [
  { topic: "deleting", words: /\b(delet\w*|remov\w*|drop\w*|eras(e|es|ed|ing|ure)|wip(e|es|ed|ing)|purg\w*|destroy\w*|rm)\b/i },
  { topic: "security", words: /\b(secur\w*|insecur\w*|vulnerab\w*|exploit\w*)\b/i },
  { topic: "keys or credentials", words: /\b(keys?|credentials?|secrets?|passwords?|passphrases?|tokens?)\b/i },
  { topic: "merging", words: /\bmerg\w*/i },
  { topic: "pushing", words: /\bpush\w*\b/i },
  { topic: "releasing", words: /\b(releas\w*|publish\w*|deploy\w*)/i },
  { topic: "spending", words: /\b(spend\w*|spent|pay|pays|paying|paid|payments?|costs?|costing|billing|purchas\w*|buy\w*|budget\w*)\b/i },
  { topic: "anything that cannot be undone", words: /\b(irreversib\w*|irrevocab\w*|permanent\w*|undoable|(cannot|can't|can not) be (undone|reversed)|force[- ]push\w*)/i },
  { topic: "a site's look", words: /\b(look|looks|looking|appearance|visual\w*|screenshots?|previews?)\b/i },
  { topic: "legal text", words: /\b(legal\w*|laws?|privacy polic(y|ies)|terms of use|consent\w*|offers?)\b/i },
  { topic: "logins", words: /\b(log-?ins?|log in|sign[- ]in|auth|authn|authz|authenticat\w*|authoriz\w*|oauth\w*)\b/i }
]

const neverDecidedReason = (question: string): string | null => {
  for (const entry of neverDecided) {
    const found = entry.words.exec(question)
    if (found !== null) {
      return "orc never hands the decider a question about " + entry.topic + ", and this one says " + JSON.stringify(found[0])
    }
  }
  return null
}

const routineAction = "none"

const actionWords: ReadonlyMap<string, string> = new Map([["merge", "merge"], ["delete", "delete unlanded work"], ["login", "log in"]])

const askedActionReason = (asks: string): string | null => {
  if (asks === routineAction) {
    return null
  }
  const named = actionWords.get(asks)
  return named === undefined
    ? "the review question asks the owner for the action " + JSON.stringify(asks) + ", which orc does not know, so orc hands it to the owner"
    : "the review question asks the owner to " + named + ", and orc hands every asked action to the owner"
}

// A question that names no asked action falls back to the word list, so a missing field never lets a guarded question through.
export const guardReason = (question: { readonly text: string; readonly asks?: string | undefined }): string | null =>
  question.asks === undefined ? neverDecidedReason(question.text) : askedActionReason(question.asks)

export const askBackWords = (question: string): string =>
  "Before it answers, orc's decider asks you: " + question + "\nPut your reply in a new orc_ask question."
