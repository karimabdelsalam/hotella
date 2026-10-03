/**
 * The housekeeping assignment proposal (BUILD_PLAN 7.B, "Housekeeping Copilot" v1): the day's open jobs balanced across
 * the attendants a supervisor chose, by credits, keeping a floor with one attendant where that does not unbalance the
 * day. Deterministic code (rule 11); it only proposes — a person applies or edits it.
 */

export interface BalancerJob {
  readonly jobId: string;
  readonly roomNumber: string;
  /** The floor label, or null (then the room number without its last two digits stands in). */
  readonly floor: string | null;
  readonly credits: number;
}

export interface AttendantLoad {
  readonly attendantId: string;
  readonly credits: number;
  readonly jobs: readonly BalancerJob[];
}

/** A floor bigger than this share of an attendant's fair load is split room by room. */
const FLOOR_SPLIT_FACTOR = 1.2;

const byRoom = (a: BalancerJob, b: BalancerJob) =>
  a.roomNumber.localeCompare(b.roomNumber, 'en', { numeric: true });
const round = (n: number) => Math.round(n * 100) / 100;

export function floorOf(job: BalancerJob): string {
  return job.floor ?? (job.roomNumber.length > 2 ? job.roomNumber.slice(0, -2) : '0');
}

export function proposeAssignments(
  jobs: readonly BalancerJob[],
  attendantIds: readonly string[],
): AttendantLoad[] {
  const attendants = [...new Set(attendantIds)];
  if (attendants.length === 0) return [];
  const loads = attendants.map((attendantId) => ({
    attendantId,
    credits: 0,
    jobs: [] as BalancerJob[],
  }));
  const total = jobs.reduce((sum, j) => sum + j.credits, 0);
  const fair = total / attendants.length;
  const floors = new Map<string, BalancerJob[]>();
  for (const job of [...jobs].sort(byRoom)) {
    const key = floorOf(job);
    floors.set(key, [...(floors.get(key) ?? []), job]);
  }
  // Largest floors first (longest-processing-time), ties by floor label: the same input always gives the same plan.
  const groups = [...floors.entries()]
    .map(([floor, list]) => ({ floor, list, credits: list.reduce((s, j) => s + j.credits, 0) }))
    .sort(
      (a, b) => b.credits - a.credits || a.floor.localeCompare(b.floor, 'en', { numeric: true }),
    );
  const lightest = () =>
    loads.reduce((min, l) => (l.credits < min.credits - 1e-9 ? l : min), loads[0]!);
  for (const group of groups) {
    const units =
      attendants.length > 1 && group.credits > fair * FLOOR_SPLIT_FACTOR
        ? group.list.map((j) => [j])
        : [group.list];
    for (const unit of units) {
      const target = lightest();
      target.jobs.push(...unit);
      target.credits += unit.reduce((s, j) => s + j.credits, 0);
    }
  }
  return loads.map((l) => ({
    attendantId: l.attendantId,
    credits: round(l.credits),
    jobs: [...l.jobs].sort(byRoom),
  }));
}
