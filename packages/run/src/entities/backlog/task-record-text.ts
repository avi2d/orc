const prUrlPattern = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+$/

export const fullPrUrl = (pr: string | null | undefined): string | null => pr !== null && pr !== undefined && prUrlPattern.test(pr) ? pr : null

const datePattern = /^\d{4}-\d{2}-\d{2}$/

export const isCalendarDate = (text: string): boolean =>
  datePattern.test(text) && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text
