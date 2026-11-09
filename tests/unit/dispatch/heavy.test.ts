import { describe, expect, test } from "bun:test"
import { classifyHeavy, heavyBinDir, heavyGroup, withHeavyPath } from "../../../packages/run/src/dispatch/heavy"

describe("heavy queue classifier", () => {
  test("the group is heavy", () => {
    expect(heavyGroup).toBe("heavy")
  })

  test("the stand-in folder lives under the home", () => {
    expect(heavyBinDir("/tmp/home")).toBe("/tmp/home/heavy/bin")
  })

  test("the stand-in folder prefixes the inherited path", () => {
    expect(withHeavyPath("/home", "/usr/bin:/bin")).toBe("/home/heavy/bin:/usr/bin:/bin")
  })

  test("bun test on a named test file queues with priority", () => {
    expect(classifyHeavy("bun", ["test", "login.test.ts"], [])).toEqual({ queue: true, priority: 1 })
  })

  test("bun test on a bare word queues without priority", () => {
    expect(classifyHeavy("bun", ["test", "x"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("a whole bun test run queues without priority", () => {
    expect(classifyHeavy("bun", ["test"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("bun test with a filter queues with priority", () => {
    expect(classifyHeavy("bun", ["test", "-t", "login"], [])).toEqual({ queue: true, priority: 1 })
  })

  test("bun install never queues", () => {
    expect(classifyHeavy("bun", ["install"], [])).toEqual({ queue: false, priority: 0 })
  })

  test("bun run build queues", () => {
    expect(classifyHeavy("bun", ["run", "build"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("bun run finds the script past option flags", () => {
    expect(classifyHeavy("bun", ["run", "--filter", "proj", "build"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("bun x runs a heavy tool through the queue", () => {
    expect(classifyHeavy("bun", ["x", "vitest", "run"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("bun x on a targeted tool queues with priority", () => {
    expect(classifyHeavy("bun", ["x", "vitest", "login.test.ts"], [])).toEqual({ queue: true, priority: 1 })
  })

  test("bun run dev never queues", () => {
    expect(classifyHeavy("bun", ["run", "dev"], [])).toEqual({ queue: false, priority: 0 })
  })

  test("a bun test watch run never queues", () => {
    expect(classifyHeavy("bun", ["test", "--watch"], [])).toEqual({ queue: false, priority: 0 })
  })

  test("go test queues with priority on a named package", () => {
    expect(classifyHeavy("go", ["test", "./pkg/foo"], [])).toEqual({ queue: true, priority: 1 })
  })

  test("a whole go test run queues without priority", () => {
    expect(classifyHeavy("go", ["test", "./..."], [])).toEqual({ queue: true, priority: 0 })
  })

  test("go vet queues", () => {
    expect(classifyHeavy("go", ["vet", "./..."], [])).toEqual({ queue: true, priority: 0 })
  })

  test("go test with an option value queues without priority", () => {
    expect(classifyHeavy("go", ["test", "-timeout", "10m", "./..."], [])).toEqual({ queue: true, priority: 0 })
  })

  test("vitest run queues without priority", () => {
    expect(classifyHeavy("vitest", ["run"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("eslint on a bare folder queues without priority", () => {
    expect(classifyHeavy("eslint", ["src"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("tsc with an option value queues without priority", () => {
    expect(classifyHeavy("tsc", ["-p", "tsconfig.json"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("bun test with an option value queues without priority", () => {
    expect(classifyHeavy("bun", ["test", "--timeout", "20000"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("npm test queues without priority", () => {
    expect(classifyHeavy("npm", ["test"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("npm run test with a filter queues with priority", () => {
    expect(classifyHeavy("npm", ["run", "test", "--", "-t", "login"], [])).toEqual({ queue: true, priority: 1 })
  })

  test("npm install never queues", () => {
    expect(classifyHeavy("npm", ["install"], [])).toEqual({ queue: false, priority: 0 })
  })

  test("npx runs a heavy tool through the queue", () => {
    expect(classifyHeavy("npx", ["vitest", "run"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("go version never queues", () => {
    expect(classifyHeavy("go", ["version"], [])).toEqual({ queue: false, priority: 0 })
  })

  test("a machine command queues under its first word", () => {
    expect(classifyHeavy("checks-test", ["--changed"], ["checks-test"])).toEqual({ queue: true, priority: 1 })
  })

  test("an unknown command never queues", () => {
    expect(classifyHeavy("rg", ["foo"], [])).toEqual({ queue: false, priority: 0 })
  })

  test("xcodebuild queues", () => {
    expect(classifyHeavy("xcodebuild", ["-scheme", "App"], [])).toEqual({ queue: true, priority: 0 })
  })

  test("xcrun simctl boot queues", () => {
    expect(classifyHeavy("xcrun", ["simctl", "boot", "uuid"], [])).toEqual({ queue: true, priority: 0 })
  })
})
