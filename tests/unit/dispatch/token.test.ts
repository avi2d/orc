import { describe, expect, test } from "bun:test"
import { DateTime, Option, Redacted } from "effect"
import { decodeTokenText, tokenLive } from "../../../packages/run/src/entities/token/index"

describe("the token document", () => {
  const placeholder = "orc-test-placeholder-not-a-token"
  const document = (fields: object) => JSON.stringify({ schema: "orc.token.v1", token: placeholder, expiresAt: "2026-10-30T12:00:00.000Z", ...fields })
  test("reads the token and its expiry", () => {
    const token = Option.getOrThrow(decodeTokenText(document({})))
    expect(Redacted.value(token.token)).toBe(placeholder)
    expect(DateTime.formatIso(token.expiresAt)).toBe("2026-10-30T12:00:00.000Z")
  })
  test("a token holding a space is refused instead of reaching the provider cut at it", () => {
    expect(Option.isNone(decodeTokenText(document({ token: "two words" })))).toBe(true)
  })
  test("an unknown key is refused instead of ignored", () => {
    expect(Option.isNone(decodeTokenText(document({ refreshToken: placeholder })))).toBe(true)
  })
  test("another schema is refused instead of read as a token", () => {
    expect(Option.isNone(decodeTokenText(document({ schema: "orc.token.v2" })))).toBe(true)
  })
  test("a token printed as a redacted value never shows its text", () => {
    const token = Option.getOrThrow(decodeTokenText(document({})))
    expect(Bun.inspect(token)).not.toContain(placeholder)
    expect(JSON.stringify(token)).not.toContain(placeholder)
  })
  test("a token running out within five minutes is lapsed instead of live", () => {
    const now = DateTime.makeUnsafe("2026-10-30T12:00:00.000Z")
    expect(tokenLive(DateTime.makeUnsafe("2026-10-30T12:05:00.000Z"), now)).toBe(false)
    expect(tokenLive(DateTime.makeUnsafe("2026-10-30T12:05:01.000Z"), now)).toBe(true)
  })
})
