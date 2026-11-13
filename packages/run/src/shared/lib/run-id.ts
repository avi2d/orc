export const isRunId = (text: string): boolean => /^[A-Za-z0-9_.-]{1,64}$/.test(text)

export const newRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  const random = Math.random().toString(16).slice(2, 8)
  return stamp + "-" + random
}
