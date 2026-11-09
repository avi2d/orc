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

  test("bun test on a named file queues with priority", () => {
    expect(classifyHeavy("bun", ["test", "x"], [])).toEqual({ queue: true, priority: 1 })
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
