export type Level = "over" | "under" | "unknown";

export interface Episode {
  readonly since: number;
  readonly fired: boolean;
}

export interface EpisodeStep {
  readonly episode: Episode | undefined;
  readonly fire: boolean;
}

// A sample that could not be read says nothing of the level, so it neither extends nor ends an episode.
export const episodeStep = (episode: Episode | undefined, level: Level, now: number, sustainedMillis: number): EpisodeStep => {
  if (level === "under") return { episode: undefined, fire: false };
  if (level === "unknown") return { episode, fire: false };
  const current = episode ?? { since: now, fired: false };
  const fire = !current.fired && now - current.since >= sustainedMillis;
  return { episode: fire ? { since: current.since, fired: true } : current, fire };
};

export interface Stepped<S, E> {
  readonly state: S;
  readonly events: ReadonlyArray<E>;
}
