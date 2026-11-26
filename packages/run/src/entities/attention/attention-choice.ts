import type { Asked, AttentionItem, AttentionOption } from "./attention-item"
import type { Choice } from "./attention-ask"

const choiceOf = (asked: Choice): Choice => ({
  ...(asked.subject === undefined ? {} : { subject: asked.subject }),
  ...(asked.options === undefined ? {} : { options: asked.options }),
  ...(asked.recommendation === undefined ? {} : { recommendation: asked.recommendation })
})

const sameOption = (left: AttentionOption, right: AttentionOption | undefined): boolean =>
  right !== undefined && left.text === right.text && left.outcome === right.outcome && left.picture === right.picture && left.action === right.action

export const sameChoice = (left: Choice, right: Choice): boolean => {
  const leftOptions = left.options ?? []
  const rightOptions = right.options ?? []
  return left.subject === right.subject && left.recommendation === right.recommendation &&
    leftOptions.length === rightOptions.length && leftOptions.every((option, index) => sameOption(option, rightOptions[index]))
}

export const withChoice = (item: AttentionItem, asked: Asked): AttentionItem => {
  const { subject: _subject, options: _options, recommendation: _recommendation, ...rest } = item
  return { ...rest, text: asked.text, owner: asked.owner, ...choiceOf(asked) }
}
