import { describe, expect, test } from "bun:test"
import {
  classifyHeavyCall,
  decisionWords,
  type HeavyDecision
} from "../../../packages/run/src/dispatch/heavy-classify"

const decide = (call: string, commands: ReadonlyArray<string> = []): HeavyDecision => {
  const [tool = "", ...args] = call.split(" ").filter((word) => word !== "")
  return classifyHeavyCall(tool, commands, args)
}

describe("classifyHeavyCall", () => {
  test.each([
    ["bun test login.test.ts", "prioritized"],
    ["bun test", "queued"],
    ["bun test --timeout 20000", "queued"],
    ["bun test login", "prioritized"],
    ["bun --filter web test", "queued"],
    ["bun --filter=web test", "queued"],
    ["bun build", "queued"],
    ["bun x vitest login.test.ts", "prioritized"],
    ["bun vitest run", "queued"],
    ["bun run --filter proj build", "queued"],
    ["bun run build:ci", "queued"],
    ["bun run tsc", "queued"],
    ["bun run test -t login", "prioritized"],
    ["npm t", "queued"],
    ["npm --prefix web test", "queued"],
    ["npm exec -- vitest run", "queued"],
    ["npm run test -- -t login", "prioritized"],
    ["pnpm -r test", "queued"],
    ["pnpm vitest run", "queued"],
    ["yarn workspace web test", "queued"],
    ["npx vitest run", "queued"],
    ["vitest run", "queued"],
    ["vitest login", "prioritized"],
    ["jest --maxWorkers 2", "queued"],
    ["jest login", "prioritized"],
    ["tsc -p tsconfig.json", "queued"],
    ["eslint src", "queued"],
    ["pytest -c cfg.ini -k foo", "prioritized"],
    ["pytest tests/test_login.py", "prioritized"],
    ["playwright test --project chromium -g login", "prioritized"],
    ["go test ./pkg/foo", "prioritized"],
    ["go test ./...", "queued"],
    ["go test -timeout 10m ./...", "queued"],
    ["go build -o bin/app ./cmd/app", "prioritized"],
    ["go vet ./...", "queued"],
    ["cargo test", "queued"],
    ["xcodebuild -scheme App", "queued"],
    ["xcrun simctl boot uuid", "queued"]
  ] as const)("%s queues as %s instead of running directly", (call, expected) => {
    expect(decide(call)).toBe(expected)
  })

  test.each([
    "bun",
    "bun install",
    "bun --version",
    "bun test --watch",
    "bun run dev",
    "bun run test:ui",
    "bun run scripts/release.ts build",
    "npm install",
    "npm run test:watch",
    "npm run deploy -- --env test",
    "pnpm run dev",
    "npx tsc -w",
    "vitest -w",
    "vitest dev",
    "vitest watch",
    "tsc -w",
    "tsc --watch",
    "playwright show-report",
    "go version",
    "go",
    "cargo --version",
    "xcodebuild --help",
    "xcrun simctl list",
    "mytool foo"
  ])("%s runs directly instead of queueing", (call) => {
    expect(decide(call)).toBe("direct")
  })

  test("a configured subcommand queues past the built-in rules instead of running directly", () => {
    expect(decide("cargo nextest run", ["cargo nextest"])).toBe("queued")
    expect(decide("npm --prefix web ci", ["npm ci"])).toBe("queued")
    expect(decide("npm ci")).toBe("direct")
  })

  test("a configured bare command queues every call but a watch run instead of running directly", () => {
    expect(decide("checks-test --changed", ["checks-test"])).toBe("prioritized")
    expect(decide("checks-test", ["checks-test"])).toBe("queued")
    expect(decide("checks-test --watch", ["checks-test"])).toBe("direct")
  })

  test("a configured subcommand keeps the priority the built-in rules gave instead of dropping it", () => {
    expect(decide("bun test login.test.ts", ["bun nightly"])).toBe("prioritized")
  })

  test("a tool named like an object property runs directly instead of throwing", () => {
    expect(decide("toString test")).toBe("direct")
    expect(decide("constructor x", ["constructor x"])).toBe("queued")
  })
})

describe("decisionWords", () => {
  test("each decision reads as the queue and priority bits instead of one word", () => {
    expect(decisionWords("direct")).toBe("0 0")
    expect(decisionWords("queued")).toBe("1 0")
    expect(decisionWords("prioritized")).toBe("1 1")
  })
})
