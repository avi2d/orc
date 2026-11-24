import type { Command } from "./runner-exec"

const compiledMain = (main: string): boolean =>
  main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main)

export const selfCommand = (execPath: string, main: string): Command =>
  compiledMain(main) ? [execPath] : [execPath, main]
