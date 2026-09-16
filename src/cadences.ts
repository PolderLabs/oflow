import { loadProjectGroupContext } from "./group.js";
import type { GitLabIterationCadence } from "./types.js";

export interface IterationCadenceSummary {
  id: string;
  title: string | null;
  active: boolean | null;
  automatic: boolean | null;
  durationInWeeks: number | null;
  iterationsInAdvance: number | null;
  rollOver: boolean | null;
  startDate: string | null;
}

export interface IterationCadenceListResult {
  groupPath: string;
  cadences: IterationCadenceSummary[];
  mayBeTruncated: boolean;
}

export async function listIterationCadences(
  root: string,
  limit: number,
): Promise<IterationCadenceListResult> {
  const context = await loadProjectGroupContext(root);
  const result = await context.client.listIterationCadences(context.groupPath, limit);
  return {
    groupPath: context.groupPath,
    cadences: result.cadences.map(compactCadence),
    mayBeTruncated: result.mayBeTruncated,
  };
}

export function formatIterationCadenceMarkdown(
  result: IterationCadenceListResult,
): string {
  const lines = [
    "# oflow cadence",
    "",
    "Group: " + result.groupPath,
    "Count: " + String(result.cadences.length) +
      (result.mayBeTruncated ? " (more may exist)" : ""),
    "",
  ];
  if (result.cadences.length === 0) {
    lines.push("_No iteration cadences found._");
  } else {
    lines.push(...result.cadences.map(formatCadence));
  }
  lines.push(
    "",
    "Cadences are group-scoped; use `oflow iteration --group --state current --json` for sprint instances.",
    "",
  );
  return lines.join("\n");
}

function compactCadence(cadence: GitLabIterationCadence): IterationCadenceSummary {
  return {
    id: cadence.id,
    title: cadence.title ?? null,
    active: cadence.active ?? null,
    automatic: cadence.automatic ?? null,
    durationInWeeks: cadence.duration_in_weeks ?? null,
    iterationsInAdvance: cadence.iterations_in_advance ?? null,
    rollOver: cadence.roll_over ?? null,
    startDate: cadence.start_date ?? null,
  };
}

function formatCadence(cadence: IterationCadenceSummary): string {
  const title = cadence.title ?? "(untitled cadence)";
  const schedule = cadence.durationInWeeks === null
    ? "manual"
    : String(cadence.durationInWeeks) + " week" +
      (cadence.durationInWeeks === 1 ? "" : "s") +
      (cadence.automatic === true ? ", automatic" : ", manual");
  const rollover = cadence.rollOver === null
    ? "rollover unknown"
    : cadence.rollOver ? "rollover on" : "rollover off";
  const status = cadence.active === null
    ? "active unknown"
    : cadence.active ? "active" : "inactive";
  return "- " + title + " (" + status + "; " + schedule + "; " + rollover + ")";
}
