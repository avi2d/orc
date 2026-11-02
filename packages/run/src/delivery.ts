const deliveryModes = ["no-mistakes", "direct-PR", "no-mistakes-prod-only"] as const
export type DeliveryMode = typeof deliveryModes[number]
export const runDeliveries = ["no-mistakes", "direct-PR"] as const satisfies ReadonlyArray<DeliveryMode>
export type RunDelivery = typeof runDeliveries[number]

export const isDeliveryMode = (word: string): word is DeliveryMode => deliveryModes.some((mode) => mode === word)

export const isRunDelivery = (word: string): word is RunDelivery => runDeliveries.some((delivery) => delivery === word)

export const unknownMode = (project: string, word: string): string =>
  "the project " + project + " names the mode " + word + ", which is not no-mistakes, direct-PR or no-mistakes-prod-only"

export const deliveryFor = (mode: DeliveryMode, internal: boolean): RunDelivery =>
  mode === "direct-PR" || (mode === "no-mistakes-prod-only" && internal) ? "direct-PR" : "no-mistakes"
