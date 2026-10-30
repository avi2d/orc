interface Ranked {
  readonly name: string;
  readonly working: number;
  readonly waiting: number;
  readonly parked: number;
  readonly blocked: number;
  readonly held: number;
  readonly planned: ReadonlyArray<{ readonly next: number | undefined }>;
}

const liveTotalOf = (project: Ranked): number => project.working + project.waiting + project.parked + project.blocked;

// The report lists ready entries tier first, so a project's earliest ready entry ranks it among the projects with nothing live.
const nextOf = (project: Ranked): number => Math.min(...project.planned.map((row) => row.next ?? Number.POSITIVE_INFINITY));

export const byProject = (left: Ranked, right: Ranked): number =>
  liveTotalOf(right) - liveTotalOf(left) ||
  right.working - left.working ||
  nextOf(left) - nextOf(right) ||
  right.held - left.held ||
  left.name.localeCompare(right.name);
