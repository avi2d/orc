import { Context, DateTime, Effect, Layer, Option } from "effect";
import { SavedProfilesSource } from "../sources/saved-profiles";
import { readQuota } from "../sources/quota-read";
import { type QuotaReadings, type QuotaReadSources, sessionQuotaOf, type SessionSources } from "../sources/session-quota-read";
import type { QueueReadings } from "../views/queues";
import { type QuotaBlock, quotaBlocks } from "../views/quotas";
import type { SessionQuotaView } from "../views/session-quota";
import type { TaskLevels, TaskListing } from "../views/task-levels";
import { readsCadence } from "./cadence";
import { QuotaBlocksCodec, SessionsCodec } from "./codecs";
import { type Freshness, type Polled, polled, refreshingOf, type SavedReadings, savedStandIn, type Shown } from "./feed";

export interface QuotaFeedShape {
  readonly readings: Polled<QuotaReadings>;
  readonly blocks: Effect.Effect<Shown<ReadonlyArray<QuotaBlock>>>;
  readonly refreshing: Effect.Effect<boolean>;
}

export class QuotaFeed extends Context.Service<QuotaFeed, QuotaFeedShape>()("@tui-dash/schema/QuotaFeed") {}

export class SessionsFeed extends Context.Service<SessionsFeed, { readonly read: Effect.Effect<Shown<SessionQuotaView>>; readonly refreshing: Effect.Effect<boolean> }>()(
  "@tui-dash/schema/SessionsFeed",
) {}

export interface MachineListing {
  readonly machine: string;
  readonly listing: TaskListing;
}

// The projects board reads every machine's tasks report at once, so one project with tasks on both machines keeps one row.
export interface TaskBoard {
  readonly levels: TaskLevels;
  readonly byMachine: ReadonlyMap<string, TaskLevels>;
  readonly zone: DateTime.TimeZone;
  readonly listings: ReadonlyArray<MachineListing>;
  readonly shownAt: ReadonlyMap<string, Freshness>;
  readonly freshness: ReadonlyArray<Freshness>;
}

export interface TaskListings {
  readonly local: string;
  readonly zone: DateTime.TimeZone;
  readonly listings: ReadonlyArray<MachineListing>;
  readonly freshness: ReadonlyArray<Freshness>;
}

export class TaskBoardFeed extends Context.Service<
  TaskBoardFeed,
  { readonly read: Effect.Effect<TaskBoard>; readonly listings: Effect.Effect<TaskListings>; readonly refreshing: Effect.Effect<boolean>; readonly listingsRefreshing: Effect.Effect<boolean> }
>()("@tui-dash/schema/TaskBoardFeed") {}

export interface QueueShown {
  readonly shown: Shown<QueueReadings>;
  readonly fresh: QueueReadings;
  readonly freshness: ReadonlyArray<Freshness>;
}

export class QueueFeed extends Context.Service<QueueFeed, { readonly read: Effect.Effect<QueueShown>; readonly refreshing: Effect.Effect<boolean> }>()("@tui-dash/schema/QueueFeed") {}

export const quotaFeedLayer: Layer.Layer<QuotaFeed, never, QuotaReadSources | SavedReadings> = Layer.effect(
  QuotaFeed,
  Effect.gen(function* () {
    const savedProfiles = yield* SavedProfilesSource;
    const quota = yield* polled(readQuota, readsCadence);
    const login = yield* polled(savedProfiles.read, readsCadence);
    const readings: Polled<QuotaReadings> = {
      latest: Effect.map(
        Effect.all({ quota: quota.latest, savedProfiles: login.latest }, { concurrency: "unbounded" }),
        (latest) =>
          Option.map(Option.all(latest), (answered) => ({
            value: { quota: answered.quota.value, savedProfiles: answered.savedProfiles.value },
            at: Math.min(answered.quota.at, answered.savedProfiles.at),
          })),
      ),
      settled: Effect.all({ quota: quota.settled, savedProfiles: login.settled }, { concurrency: "unbounded" }),
      refreshing: refreshingOf([quota, login]),
    };
    const standIn = yield* savedStandIn("quota", QuotaBlocksCodec);
    const blocks = Effect.gen(function* () {
      const now = yield* DateTime.now;
      return yield* standIn(Option.map(yield* readings.latest, ({ value, at }) => ({ value: quotaBlocks(value.quota, value.savedProfiles, now), at })));
    });
    return { readings, blocks, refreshing: readings.refreshing };
  }),
);

export const sessionsFeedLayer: Layer.Layer<SessionsFeed, never, QuotaFeed | SessionSources | SavedReadings> = Layer.effect(
  SessionsFeed,
  Effect.gen(function* () {
    const quota = yield* QuotaFeed;
    // settled waits for the first quota answers, so the latest pair it releases is present.
    const consumed = Effect.flatMap(quota.readings.settled, () => Effect.map(quota.readings.latest, Option.getOrThrow));
    const sessions = yield* polled(
      Effect.flatMap(consumed, (quotas) => Effect.map(sessionQuotaOf(Effect.succeed(quotas.value)), (value) => ({ value, at: quotas.at }))),
      readsCadence,
    );
    const standIn = yield* savedStandIn("sessions", SessionsCodec);
    const latest = Effect.map(sessions.latest, Option.map((stamped) => ({ value: stamped.value.value, at: stamped.value.at })));
    return { read: Effect.flatMap(latest, standIn), refreshing: sessions.refreshing };
  }),
);
