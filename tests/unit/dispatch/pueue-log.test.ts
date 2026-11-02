import { describe, expect, test } from "bun:test"
import { pueueConfigFile, pueueFolder } from "../../../packages/run/src/dispatch/pueue-log"

describe("where pueue keeps its task logs", () => {
  test("linux with no config reads the XDG data folder instead of the config folder", () => {
    expect(pueueFolder(null, { HOME: "/home/a" }, "linux")).toBe("/home/a/.local/share/pueue")
    expect(pueueFolder(null, { HOME: "/home/a", XDG_DATA_HOME: "/data" }, "linux")).toBe("/data/pueue")
  })
  test("macOS reads Application Support instead of the XDG folders", () => {
    expect(pueueFolder(null, { HOME: "/Users/a", XDG_DATA_HOME: "/data" }, "darwin")).toBe("/Users/a/Library/Application Support/pueue")
    expect(pueueConfigFile({ HOME: "/Users/a" }, "darwin")).toBe("/Users/a/Library/Application Support/pueue/pueue.yml")
  })
  test("a configured pueue_directory wins and expands its tilde instead of being ignored", () => {
    expect(pueueFolder("shared:\n  pueue_directory: ~/queue\n", { HOME: "/home/a" }, "linux")).toBe("/home/a/queue")
    expect(pueueFolder("shared:\n  pueue_directory: /srv/queue\n", { HOME: "/home/a" }, "linux")).toBe("/srv/queue")
  })
  test("PUEUE_CONFIG_PATH names the config file instead of the XDG config folder", () => {
    expect(pueueConfigFile({ HOME: "/home/a", PUEUE_CONFIG_PATH: "/etc/q.yml" }, "linux")).toBe("/etc/q.yml")
    expect(pueueConfigFile({ HOME: "/home/a", XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe("/cfg/pueue/pueue.yml")
  })
  test("a config that is not yaml falls back to the default folder instead of failing the read", () => {
    expect(pueueFolder("shared: [", { HOME: "/home/a" }, "linux")).toBe("/home/a/.local/share/pueue")
  })
})
