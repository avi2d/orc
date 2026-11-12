export const sandboxKinds = ["nono", "none"] as const
export type SandboxKind = typeof sandboxKinds[number]
