import { DateTime } from "effect";
import type { Session } from "../sessions/live";
import type { QuotaProviderId } from "../sources/quota";
import { sumTokens, tokenTotal } from "../sessions/tokens";
import type { ModelTokens } from "./session-models";
import type { SessionQuotaView } from "./session-quota";
import { type TaskFolders, taskOwning } from "./task-resources";

export interface FairShare {
  readonly account: string;
  readonly cycleSeconds: number;
  readonly ratio: number;
  readonly flagged: boolean;
}

export interface TaskSpend {
  readonly model: string | undefined;
  readonly tokens: number;
  readonly outputTokens: number | undefined;
  readonly fair: FairShare | undefined;
  readonly provider: QuotaProviderId | undefined;
}

// A pool folder serves one task after another, so a session belongs to the task that held its folder when it first called today.
const sessionOwner = (tasks: ReadonlyArray<TaskFolders>, session: Session, startedAt: DateTime.Utc): TaskFolders | undefined =>
  taskOwning(tasks, { folder: session.cwd, startedAtMillis: DateTime.toEpochMillis(startedAt) }, 0);

const fairShares = (view: SessionQuotaView, owned: (session: Session) => boolean): ReadonlyArray<FairShare> =>
  view.accounts.flatMap((account) =>
    account.body.kind !== "windows"
      ? []
      : account.body.windows.flatMap((window) => {
          const fair = window.fairPointsPerHour;
          if (fair === null || fair <= 0 || !window.aheadOfPace || !window.pastFirstTenth) return [];
          return window.sessions
            .filter((row) => owned(row.session) && row.priced.pointsPerHour > 0)
            .map((row) => ({ account: account.title, cycleSeconds: window.cycleSeconds, ratio: row.priced.pointsPerHour / fair, flagged: row.flagged }));
        }),
  );

// A flag outranks any ratio, since the flag is what the reader acts on.
const byConcern = (left: FairShare, right: FairShare): number => Number(right.flagged) - Number(left.flagged) || right.ratio - left.ratio;

// The dot sits before the top model's badge, so it takes the colour of the account that billed that model.
const providerOf = (models: ReadonlyArray<ModelTokens>, model: string | undefined): QuotaProviderId | undefined => {
  const shares = Map.groupBy(
    models.filter((entry) => entry.model === model),
    (entry) => entry.provider,
  );
  return [...shares.entries()]
    .map(([provider, own]) => ({ provider, tokens: tokenTotal(sumTokens(own.map((entry) => entry.tokens))) }))
    .toSorted((left, right) => right.tokens - left.tokens)
    .at(0)?.provider;
};

export const taskSpend = (
  view: SessionQuotaView,
  tasks: ReadonlyArray<TaskFolders>,
  isLocal: (session: Session) => boolean,
): ReadonlyMap<string, TaskSpend> => {
  // A session id is unique only on its own machine.
  const firstCalls = new Map(view.modelsSinceMidnight.filter((entry) => isLocal(entry.session)).map((entry) => [entry.session.id, entry.firstCallAt]));
  const ownerOf = new Map(
    view.sessions.flatMap((session) => {
      const owner = isLocal(session) ? sessionOwner(tasks, session, firstCalls.get(session.id) ?? view.now) : undefined;
      return owner === undefined ? [] : [[session.id, owner.id] as const];
    }),
  );
  const spend = new Map<string, TaskSpend>();
  for (const id of new Set(ownerOf.values())) {
    const mine = (session: Session) => isLocal(session) && ownerOf.get(session.id) === id;
    const models = view.modelsSinceMidnight.filter((entry) => mine(entry.session)).flatMap((entry) => entry.models);
    const byModel = [...Map.groupBy(models, (entry) => entry.model).entries()]
      .map(([model, own]) => ({ model, tokens: tokenTotal(sumTokens(own.map((entry) => entry.tokens))) }))
      .toSorted((left, right) => right.tokens - left.tokens);
    const fair = fairShares(view, mine).toSorted(byConcern).at(0);
    if (byModel.length === 0 && fair === undefined) continue;
    spend.set(id, {
      model: byModel.at(0)?.model,
      tokens: byModel.reduce((total, entry) => total + entry.tokens, 0),
      outputTokens: models.reduce((total, entry) => total + entry.tokens.output, 0),
      fair,
      provider: providerOf(models, byModel.at(0)?.model),
    });
  }
  return spend;
};
