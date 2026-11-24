import type { AccountStanding, OrcQuotaUnreadCause, QuotaBlock, QuotaBlockBody } from "@avi2dg/orc-schema";
import { type Block, noteLines, percent, span } from "@avi2dg/orc-ui";

export const indent = "  ";

// orc quota reads each account by its tightest all-models window and does not name it.
export const accountRowName = "all models";

export type DetailTone = "muted" | "success" | "warning" | "error";

const standingWords = (standing: AccountStanding, floorPercent: number): AccountDetail | undefined => {
  switch (standing) {
    case "next":
      return { text: "next run", tone: "success" };
    case "spare":
    case "used-up":
      return undefined;
    case "under-floor":
      return { text: `under the ${percent(floorPercent)} floor`, tone: "warning" };
  }
};

const unreadHeadlines = {
  "command-missing": "command not installed",
  exit: "command failed",
  timeout: "command timed out",
  "no-json": "command printed no JSON",
  spawn: "command did not start",
  schema: "reading did not parse",
  "account-missing": "an account is missing",
} as const satisfies Record<OrcQuotaUnreadCause, string>;

export interface AccountDetail {
  readonly text: string;
  readonly tone: DetailTone;
}

export const accountDetail = (body: QuotaBlockBody): AccountDetail | undefined => {
  switch (body.kind) {
    case "account":
      return standingWords(body.standing, body.floorPercent);
    case "unusable":
      return { text: "unusable", tone: "warning" };
    case "accounts-unread":
      return { text: unreadHeadlines[body.cause], tone: "error" };
    case "live":
    case "saved":
    case "absent":
    case "unread":
    case "unreachable":
    case "invalid":
      return undefined;
  }
};

const indented = (block: Block): Block => block.map((line) => [span(indent, "muted"), ...line]);

// The header names the state, so the reason below it says which program or account and why.
export const accountReasonLines = (body: QuotaBlockBody, width: number): Block => {
  if (body.kind === "unusable") return indented(noteLines(body.reason, width - indent.length, "muted", 2));
  if (body.kind === "accounts-unread") return indented(noteLines(body.reason, width - indent.length, "muted", 3));
  return [];
};

export const isFoldedAccount = (block: QuotaBlock): boolean => block.body.kind === "account" || block.body.kind === "unusable";

export const splitShown = (blocks: ReadonlyArray<QuotaBlock>, accountsShown: number): { readonly hidden: ReadonlyArray<QuotaBlock>; readonly shown: ReadonlyArray<QuotaBlock> } => {
  const hidden = blocks.filter(isFoldedAccount).slice(accountsShown);
  return { hidden, shown: blocks.filter((block) => !hidden.includes(block)) };
};

export const hiddenLine = (block: QuotaBlock, hidden: ReadonlyArray<QuotaBlock>): Block | undefined => {
  if (block === hidden[0]) return [[span(`+${hidden.length} more ${hidden.length === 1 ? "account" : "accounts"}`, "muted")]];
  return hidden.includes(block) ? [] : undefined;
};
