type JsonRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const variantName = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }
  return isRecord(value) ? (Object.keys(value)[0] ?? "") : ""
}

export interface SlotTask {
  readonly id: number
  readonly priority: number
  readonly status: string
  readonly command: string
}

export const slotTasks = (statusText: string): ReadonlyArray<SlotTask> => {
  const state = parseJson(statusText)
  if (!isRecord(state) || !isRecord(state.tasks)) {
    return []
  }
  return Object.values(state.tasks).flatMap((task) => {
    if (!isRecord(task) || typeof task.id !== "number" || typeof task.command !== "string") {
      return []
    }
    const priority = task.priority ?? 0
    return typeof priority === "number" ? [{ id: task.id, priority, status: variantName(task.status), command: task.command }] : []
  })
}

export const queuedAhead = (tasks: ReadonlyArray<SlotTask>, mine: number): number => {
  const priority = tasks.find((task) => task.id === mine)?.priority ?? 0
  return tasks.filter((task) =>
    task.status === "Queued" && (task.priority > priority || (task.priority === priority && task.id < mine))
  ).length
}

export type TaskState =
  | { readonly status: "Done"; readonly result: unknown }
  | { readonly status: "Queued" | "Running" | "Paused" | "Stashed" | "Locked" }
  | { readonly status: "unknown" }

const waitingStates: ReadonlyArray<string> = ["Queued", "Running", "Paused", "Stashed", "Locked"]

const isWaiting = (name: string): name is "Queued" | "Running" | "Paused" | "Stashed" | "Locked" => waitingStates.includes(name)

// pueue 4 nests the task under "task" in log output; a bare entry carries the status itself.
export const taskState = (logText: string, id: number): TaskState => {
  const log = parseJson(logText)
  const entry = isRecord(log) ? log[String(id)] : undefined
  if (!isRecord(entry)) {
    return { status: "unknown" }
  }
  const status = (isRecord(entry.task) ? entry.task : entry).status
  const name = variantName(status)
  if (name === "Done") {
    return { status: "Done", result: isRecord(status) && isRecord(status.Done) ? status.Done.result : undefined }
  }
  return isWaiting(name) ? { status: name } : { status: "unknown" }
}

export const exitCodeOf = (state: TaskState): number => {
  if (state.status !== "Done") {
    return 1
  }
  const result = state.result
  if (result === "Success") {
    return 0
  }
  if (variantName(result) === "FailedToSpawn") {
    return 127
  }
  return isRecord(result) && typeof result.Failed === "number" && Number.isInteger(result.Failed) && result.Failed >= 0 ? result.Failed : 1
}
