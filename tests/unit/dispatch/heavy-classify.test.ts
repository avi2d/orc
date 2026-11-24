import { describe, expect, test } from "bun:test"
import {
  classifyHeavyCall,
  decisionWords,
  isTestCall,
  type HeavyDecision
} from "../../../packages/run/src/entities/heavy-queue/heavy-classify"

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
    ["cargo t", "queued"],
    ["node --test", "queued"],
    ["python -m pytest", "queued"],
    ["python3 -m pytest", "queued"],
    ["uv run pytest", "queued"],
    ["make test", "queued"],
    ["make check", "queued"],
    ["deno test", "queued"],
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
    "node script.js",
    "node script.js --test",
    "python script.py",
    "python3 -m http.server",
    "uv run python",
    "make build",
    "deno run",
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

describe("test runner argument boundaries", () => {
  test.each([
    ["node --import tsx --test", "queued"],
    ["node --experimental-strip-types --test test/", "prioritized"],
    ["python -B -m pytest", "queued"],
    ["python3 -I -W ignore -m pytest", "queued"],
    ["python -X dev -m pytest", "queued"],
    ["uv run --frozen pytest", "queued"],
    ["uv run --locked pytest", "queued"],
    ["uv run --no-sync pytest", "queued"],
    ["uv run --python 3.12 pytest", "queued"],
    ["uv run --project app --with pytest pytest", "queued"],
    ["uv run python -m pytest", "queued"],
    ["uv run --frozen python3 -B -m pytest", "queued"],
    ["python -m pytest -v", "queued"],
    ["make test -v", "queued"]
  ] as const)("%s remains a test run instead of escaping classification", (call, decision) => {
    const [tool = "", ...args] = call.split(" ")
    expect(isTestCall(tool, args)).toBe(true)
    expect(decide(call)).toBe(decision)
  })

  test.each([
    "node script.js --test",
    "node --import tsx script.js --test",
    "node -- --test",
    "python -B script.py -m pytest",
    "python3 -c pass -m pytest",
    "python -- -m pytest",
    "uv run --frozen python script.py",
    "uv run --locked tool pytest"
  ])("%s stays a script instead of being refused as a test", (call) => {
    const [tool = "", ...args] = call.split(" ")
    expect(isTestCall(tool, args)).toBe(false)
    expect(decide(call)).toBe("direct")
  })

  test.each([
    "node --test --watch",
    "python -m pytest --watch",
    "python3 -m pytest --watch",
    "uv run pytest --watch",
    "make test --watch",
    "deno test --watch"
  ])("%s stays refused in CI-only mode without occupying the queue", (call) => {
    const [tool = "", ...args] = call.split(" ")
    expect(isTestCall(tool, args)).toBe(true)
    expect(decide(call)).toBe("direct")
    expect(decide(call, [tool])).toBe("direct")
  })

  test.each([
    "-C", "-f", "-I", "-o", "-W", "--directory", "--file", "--makefile",
    "--include-dir", "--old-file", "--assume-old", "--what-if", "--new-file", "--assume-new"
  ])("make %s consumes its value instead of treating it as a test target", (flag) => {
    for (const value of ["test", "check"]) {
      expect(isTestCall("make", [flag, value, "build"])).toBe(false)
      expect(classifyHeavyCall("make", [], [flag, value, "build"])).toBe("direct")
      expect(isTestCall("make", [flag, value, "test"])).toBe(true)
      expect(classifyHeavyCall("make", [], [flag, value, "test"])).toBe("queued")
    }
  })

  test.each(["make -Ctest build", "make --directory=test build"])(
    "%s stays a build instead of matching an attached option value", (call) => {
      expect(decide(call)).toBe("direct")
    }
  )

  test("make's option terminator preserves test targets instead of consuming them as values", () => {
    expect(isTestCall("make", ["--", "-C", "test"])).toBe(true)
    expect(decide("make -- -C test")).toBe("queued")
  })
})

describe("decisionWords", () => {
  test("each decision reads as the queue and priority bits instead of one word", () => {
    expect(decisionWords("direct")).toBe("0 0")
    expect(decisionWords("queued")).toBe("1 0")
    expect(decisionWords("prioritized")).toBe("1 1")
  })
})
