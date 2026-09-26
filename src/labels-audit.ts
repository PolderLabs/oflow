/**
 * Label coverage audit.
 *
 * A read-only summary of how each label is used across open and closed work
 * items, grouped by type and milestone. Agents were hand-rolling this by
 * fetching every issue and counting, which is slow and quietly wrong whenever
 * the listing was truncated or a work-item type was invisible.
 *
 * The honesty constraints are the point of this module, and they mirror the
 * one already recorded in the read model: a gap in what we could read must
 * never read as an absence in the project. Two gaps are carried explicitly:
 *
 * - **Truncation.** A paginated listing is not the whole project, so counts
 *   are marked `mayBeTruncated` and the output says so.
 * - **Type coverage.** Issues carrying a custom work-item type are not
 *   necessarily visible in a REST issue listing. Counts grouped by type
 *   therefore cannot claim completeness, and the output says that too.
 */
import { GitLabClient, type GitLabListPage } from "./gitlab.js";
import { OflowError } from "./errors.js";
import { isIssueType, type GitLabIssue } from "./types.js";

export interface LabelCoverageRow {
  label: string;
  open: number;
  closed: number;
  total: number;
  byType: Record<string, { open: number; closed: number }>;
  byMilestone: Record<string, { open: number; closed: number }>;
}

export interface LabelsAuditResult {
  generatedAt: string;
  projectPath: string;
  /** Only the requested label when one was named, otherwise every label in use. */
  label: string | null;
  rows: LabelCoverageRow[];
  /** Total work items examined, open plus closed. */
  scanned: number;
  /** True when the listing stopped at a page boundary. */
  mayBeTruncated: boolean;
  /**
   * Always true. Grouping by type is only as complete as the listing's type
   * coverage, and a REST issue listing cannot guarantee that. Reported so a
   * caller can carry the caveat rather than assume completeness.
   */
  typeCoverageIncomplete: true;
  warnings: string[];
}

const TRUNCATION_WARNING =
  "Listing was truncated at a page boundary, so these counts are a lower bound.";

const TYPE_COVERAGE_WARNING =
  "Type grouping is not exhaustive: work items with a custom type may be absent " +
  "from a REST issue listing, so a label can look unused here while in use.";

function emptyRow(label: string): LabelCoverageRow {
  return {
    label,
    open: 0,
    closed: 0,
    total: 0,
    byType: {},
    byMilestone: {},
  };
}

function typeKey(issue: GitLabIssue): string {
  // An absent or unrecognised type is reported as such rather than folded
  // into "issue", which would overstate how much of the project is an issue.
  const raw = typeof issue.issue_type === "string" ? issue.issue_type : null;
  if (raw === null) return "unknown";
  return isIssueType(raw) ? raw : "custom";
}

function milestoneKey(issue: GitLabIssue): string {
  const title = issue.milestone?.title;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : "none";
}

function tally(
  bucket: Record<string, { open: number; closed: number }>,
  key: string,
  state: string,
): void {
  const existing = bucket[key] ?? { open: 0, closed: 0 };
  if (state === "closed") existing.closed += 1;
  else existing.open += 1;
  bucket[key] = existing;
}

/**
 * Build the audit from an already-fetched listing. Exported so the counting
 * rules are testable without a network stub, and so another caller can reuse
 * the aggregation over its own page fetches.
 */
export function buildLabelsAudit(
  projectPath: string,
  pages: GitLabListPage<GitLabIssue>[],
  labelFilter: string | null,
  generatedAt: string,
): LabelsAuditResult {
  const rows = new Map<string, LabelCoverageRow>();
  let scanned = 0;
  let mayBeTruncated = false;

  for (const page of pages) {
    if (page.pagination.hasNextPage) mayBeTruncated = true;
    for (const issue of page.items) {
      scanned += 1;
      const labels = issue.labels ?? [];
      for (const label of labels) {
        if (labelFilter !== null && label !== labelFilter) continue;
        const row = rows.get(label) ?? emptyRow(label);
        const state = issue.state ?? "opened";
        if (state === "closed") row.closed += 1;
        else row.open += 1;
        row.total = row.open + row.closed;
        tally(row.byType, typeKey(issue), state);
        tally(row.byMilestone, milestoneKey(issue), state);
        rows.set(label, row);
      }
    }
  }

  const warnings: string[] = [];
  if (mayBeTruncated) warnings.push(TRUNCATION_WARNING);
  warnings.push(TYPE_COVERAGE_WARNING);

  const ordered = [...rows.values()].sort((left, right) =>
    right.total - left.total || left.label.localeCompare(right.label),
  );

  return {
    generatedAt,
    projectPath,
    label: labelFilter,
    rows: ordered,
    scanned,
    mayBeTruncated,
    typeCoverageIncomplete: true,
    warnings,
  };
}

/**
 * Fetch every work item the project exposes and summarise label usage.
 *
 * `maxPages` bounds the work so a large project cannot turn an audit into an
 * unbounded crawl. Hitting the bound is reported as truncation rather than
 * hidden.
 */
export async function auditLabels(options: {
  host: string;
  projectPath: string;
  label?: string | undefined;
  maxPages?: number | undefined;
  generatedAt?: string | undefined;
  client?: GitLabClient;
}): Promise<LabelsAuditResult> {
  const maxPages = options.maxPages ?? 20;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new OflowError("Label audit page limit must be a positive integer.", "INVALID_AUDIT_PAGES");
  }
  // The client is injectable so tests can drive the page loop without a
  // network; production callers pass a host and let the token resolve.
  const client = options.client ?? new GitLabClient(options.host);
  const pages: GitLabListPage<GitLabIssue>[] = [];
  for (let index = 0; index < maxPages; index += 1) {
    const page = await client.listIssuesPage(
      options.projectPath,
      "all",
      100,
      {},
      index + 1,
    );
    pages.push(page);
    // Stopping because the last page said so is the only clean exit. Running
    // out of budget instead leaves the last page's own hasNextPage set, which
    // is what flags the result as truncated -- the loop cannot reach the cap
    // without having read that flag as true.
    if (!page.pagination.hasNextPage) break;
  }
  return buildLabelsAudit(
    options.projectPath,
    pages,
    options.label ?? null,
    options.generatedAt ?? new Date().toISOString(),
  );
}

export function formatLabelsAuditMarkdown(result: LabelsAuditResult): string {
  const lines = [
    "# oflow labels audit",
    "",
    "Project: " + result.projectPath,
    result.label === null ? "Scope: every label in use" : "Scope: label " + JSON.stringify(result.label),
    "Scanned: " + String(result.scanned) + " work items",
    "",
  ];
  if (result.rows.length === 0) {
    lines.push("_No label usage found in the listing._");
  } else {
    lines.push("| Label | Open | Closed | Total |");
    lines.push("|---|---:|---:|---:|");
    for (const row of result.rows) {
      lines.push(
        "| " + row.label + " | " + String(row.open) + " | " + String(row.closed) +
        " | " + String(row.total) + " |",
      );
    }
  }
  lines.push("");
  for (const warning of result.warnings) {
    lines.push("WARNING: " + warning);
  }
  return lines.join("\n") + "\n";
}
