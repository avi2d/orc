type Command = readonly [string, ...Array<string>]

interface MachineStart {
  readonly start: ReadonlyArray<string>
}

// The sweep closes only runs its own start command queued, so a custom start keeps owning its tasks.
export const ownedBySweep = (machine: MachineStart): boolean =>
  machine.start.some((word, index) => word === "runner" && machine.start[index + 1] === "start")

const throughOf = (values: ReadonlyArray<string>): Command | null => {
  const cut = values.indexOf("--")
  if (cut === -1) {
    return null
  }
  const rest = values.slice(cut + 1)
  const [first = "", ...others] = rest
  if (first === "") {
    return null
  }
  return [first, ...others]
}

export const throughFor = (machine: MachineStart): Command | null => ownedBySweep(machine) ? throughOf(machine.start) : null
