import { expect, test } from "bun:test"
import { documents, sharedValues } from "./gpui-fakes"
import { subscriptionsSnapshot } from "../../../packages/herdr-app/src/resources"

const { readingTime, resourceReading } = await import("../../../packages/herdr-app/src/resource-reading")

test("a warm Resources open keeps the last rows and their time through a failed refresh", async () => {
  const report = "subscription-overview"
  const command = "orc-dash report " + report
  const generatedAt = "2026-01-03T11:00:00Z"
  sharedValues.delete("orc.resources." + report)
  documents.set(command, { schemaVersion: 1, generatedAt, sources: { quota: { status: "ok", report: {
    accounts: [{ title: "shared plan", quota: { status: "ok" } }], windows: []
  } } } })
  try {
    const cold = resourceReading(report, subscriptionsSnapshot)
    expect(cold.reading).toEqual({ kind: "reading" })
    const result = await cold.load()
    expect(result).toMatchObject({ kind: "ok", at: Date.parse(generatedAt), value: { value: { accounts: [{ title: "shared plan" }] } } })
    const warm = resourceReading(report, subscriptionsSnapshot)
    warm.busy = true
    expect(warm.reading).toEqual(result)
    expect(readingTime(warm)).toBe("Read " + new Date(generatedAt).toLocaleString() + ". Refreshing…")
    documents.delete(command)
    expect(await warm.load()).toMatchObject({ ...result, refreshError: expect.stringContaining(command) })
  } finally {
    documents.delete(command)
    sharedValues.delete("orc.resources." + report)
  }
})

test("a report the view refuses names the field instead of only saying the report is invalid", async () => {
  const report = "subscription-overview"
  const command = "orc-dash report " + report
  sharedValues.delete("orc.resources." + report)
  try {
    documents.set(command, { schemaVersion: 1, generatedAt: "2026-01-03T11:00:00Z" })
    expect(await resourceReading(report, subscriptionsSnapshot).load())
      .toEqual({ kind: "failed", reason: command + " printed a document this view cannot read: sources is missing" })
    documents.set(command, { schemaVersion: 1, sources: {} })
    expect(await resourceReading(report, subscriptionsSnapshot).load())
      .toEqual({ kind: "failed", reason: command + " printed a document this view cannot read: generatedAt is missing" })
  } finally {
    documents.delete(command)
    sharedValues.delete("orc.resources." + report)
  }
})
