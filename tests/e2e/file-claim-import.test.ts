import { expect, test } from "bun:test"

test("importing file claims does not load an unavailable libc", async () => {
  const file = import.meta.resolve("../../packages/run/src/shared/lib/file-claim")
  const script = `
    import { mock } from "bun:test"
    mock.module("bun:ffi", () => ({
      dlopen: () => { throw new Error("libc unavailable") },
      FFIType: { ptr: 0, i32: 0 },
      read: {}
    }))
    await import(${JSON.stringify(file)})
  `
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
})
