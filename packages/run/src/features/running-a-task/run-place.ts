export const claimedMachineName = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const name = env["ORC_RUN_MACHINE"] ?? ""
  return name === "" ? null : name
}
