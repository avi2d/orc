export const mergeBases = ["captain-word", "yolo-green"] as const
export type MergeBasis = typeof mergeBases[number]

export const isMergeBasis = (word: string): word is MergeBasis => mergeBases.some((basis) => basis === word)
