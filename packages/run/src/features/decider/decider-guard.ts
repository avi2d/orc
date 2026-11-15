interface NeverDecided {
  readonly topic: string
  readonly words: RegExp
}

// Neither the written rules nor the policy reach this list, so no prompt can widen what the decider answers.
const neverDecided: ReadonlyArray<NeverDecided> = [
  { topic: "deleting", words: /\b(delet\w*|eras(e|es|ed|ing|ure)|wip(e|es|ed|ing)|purg\w*|destroy\w*|rm)\b/i },
  { topic: "security", words: /\b(secur\w*|insecur\w*|vulnerab\w*|exploit\w*)\b/i },
  { topic: "keys or credentials", words: /\b(keys?|credentials?|secrets?|passwords?|passphrases?|tokens?)\b/i },
  { topic: "merging", words: /\bmerg\w*/i },
  { topic: "releasing", words: /\b(releas\w*|publish\w*|deploy\w*)/i },
  { topic: "spending", words: /\b(spend\w*|spent|pay|pays|paying|paid|payments?|costs?|costing|billing|purchas\w*|buy\w*|budget\w*)\b/i },
  { topic: "anything that cannot be undone", words: /\b(irreversib\w*|irrevocab\w*|permanent\w*|undoable|(cannot|can't|can not) be (undone|reversed)|force[- ]push\w*)/i }
]

export const neverDecidedReason = (question: string): string | null => {
  for (const entry of neverDecided) {
    const found = entry.words.exec(question)
    if (found !== null) {
      return "orc never hands the decider a question about " + entry.topic + ", and this one says " + JSON.stringify(found[0])
    }
  }
  return null
}

export const askBackWords = (question: string): string =>
  "Before it answers, orc's decider asks you: " + question + "\nPut your reply in a new orc_ask question."
