// packages/run/scripts/compile.ts swaps this module for one that embeds chat-tools.ts bundled into one JavaScript file, because a compiled orc carries no source tree for pi to load.
export const chatToolsBundle: string | null = null
