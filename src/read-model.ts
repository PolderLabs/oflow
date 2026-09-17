import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { OflowError } from "./errors.js";
import { exists } from "./fs.js";
import {
  LOCAL_DATABASE_RELATIVE_PATH,
  LOCAL_DATABASE_VERSION,
  localDatabasePath,
  openLocalDatabase,
} from "./sqlite.js";
import type {
  SyncBoard,
  SyncIteration,
  SyncLabel,
  SyncMergeRequest,
  SyncMilestone,
  SyncPipeline,
  SyncResult,
  SyncWorkItem,
} from "./sync.js";

const SYNC_JSON_RELATIVE_PATH = ".oflow/cache/sync.json";
const MAX_SYNC_HISTORY = 50;

export interface ReadModelStatus {
  databasePath: string;
  databaseExists: boolean;
  state: "missing" | "ready" | "migration-required" | "unsupported" | "invalid";
  schemaVersion: number | null;
  expectedSchemaVersion: number;
  project: { host: string; path: string } | null;
  latestSync: {
    generatedAt: string;
    savedAt: string;
    source: string;
    ageSeconds: number;
    branch: string | null;
    stats: SyncResult["stats"];
    warningCount: number;
  } | null;
  cache: {
    database: {
      exists: boolean;
      path: string;
      ageSeconds: number | null;
    };
    syncJson: {
      exists: boolean;
      path: string;
      ageSeconds: number | null;
    };
  };
  invalidation: {
    at: string | null;
    reason: string | null;
  };
  refreshRequest: {
    at: string | null;
    reason: string | null;
  };
  counts: {
    workItems: number;
    mergeRequests: number;
    pipelines: number;
    iterations: number;
    syncSnapshots: number;
  };
}

export interface DashboardData {
  status: ReadModelStatus;
  project: SyncResult["project"] | null;
  repository: SyncResult["repository"] | null;
  workItems: SyncWorkItem[];
  mergeRequests: SyncMergeRequest[];
  pipelines: SyncPipeline[];
  iterations: SyncIteration[];
  planning: {
    labels: SyncLabel[];
    milestones: SyncMilestone[];
    boards: SyncBoard[];
  };
  syncHistory: Array<{
    generatedAt: string;
    savedAt: string;
    source: string;
    branch: string | null;
    stats: SyncResult["stats"];
    warningCount: number;
  }>;
}

export async function saveSyncReadModel(options: {
  root: string;
  host: string;
  projectPath: string;
  result: SyncResult;
}): Promise<void> {
  const savedAt = options.result.cache.savedAt;
  const projectKey = makeProjectKey(options.host, options.projectPath);
  const snapshotJson = JSON.stringify(options.result);
  const snapshotId = createHash("sha256")
    .update(projectKey)
    .update("\n")
    .update(options.result.generatedAt)
    .update("\n")
    .update(snapshotJson)
    .digest("hex");
  const database = await openLocalDatabase(options.root);

  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      INSERT INTO projects(project_key, host, project_path, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET
        host = excluded.host,
        project_path = excluded.project_path,
        updated_at = excluded.updated_at
    `).run(projectKey, options.host, options.projectPath, savedAt);

    const upsertWorkItem = database.prepare(`
      INSERT INTO work_items(
        project_key, iid, title, state, web_url, labels_json, assignees_json,
        milestone, iteration, start_date, due_date, weight, task_completed,
        task_total, parent_iid, parent_title, parent_web_url, updated_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, iid) DO UPDATE SET
        title = excluded.title,
        state = excluded.state,
        web_url = excluded.web_url,
        labels_json = excluded.labels_json,
        assignees_json = excluded.assignees_json,
        milestone = excluded.milestone,
        iteration = excluded.iteration,
        start_date = excluded.start_date,
        due_date = excluded.due_date,
        weight = excluded.weight,
        task_completed = excluded.task_completed,
        task_total = excluded.task_total,
        parent_iid = excluded.parent_iid,
        parent_title = excluded.parent_title,
        parent_web_url = excluded.parent_web_url,
        updated_at = excluded.updated_at,
        fetched_at = excluded.fetched_at
    `);
    const clearLabels = database.prepare(
      "DELETE FROM work_item_labels WHERE project_key = ? AND iid = ?",
    );
    const insertLabel = database.prepare(
      "INSERT INTO work_item_labels(project_key, iid, label) VALUES (?, ?, ?)",
    );
    const clearAssignees = database.prepare(
      "DELETE FROM work_item_assignees WHERE project_key = ? AND iid = ?",
    );
    const insertAssignee = database.prepare(
      "INSERT INTO work_item_assignees(project_key, iid, username) VALUES (?, ?, ?)",
    );
    for (const item of options.result.workItems) {
      upsertWorkItem.run(
        projectKey,
        item.iid,
        item.title,
        item.state,
        item.webUrl,
        JSON.stringify(item.labels),
        JSON.stringify(item.assignees),
        item.milestone,
        item.iteration,
        item.startDate,
        item.dueDate,
        item.weight,
        item.taskCompletion?.completed ?? null,
        item.taskCompletion?.total ?? null,
        item.parent?.iid ?? null,
        item.parent?.title ?? null,
        item.parent?.webUrl ?? null,
        item.updatedAt,
        savedAt,
      );
      clearLabels.run(projectKey, item.iid);
      for (const label of item.labels) {
        insertLabel.run(projectKey, item.iid, label);
      }
      clearAssignees.run(projectKey, item.iid);
      for (const username of item.assignees) {
        insertAssignee.run(projectKey, item.iid, username);
      }
    }

    database.prepare("DELETE FROM merge_requests WHERE project_key = ?").run(projectKey);
    const insertMergeRequest = database.prepare(`
      INSERT INTO merge_requests(
        project_key, iid, title, state, draft, source_branch, target_branch,
        updated_at, web_url, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of options.result.mergeRequests) {
      insertMergeRequest.run(
        projectKey,
        item.iid,
        item.title,
        item.state,
        item.draft ? 1 : 0,
        item.sourceBranch,
        item.targetBranch,
        item.updatedAt,
        item.webUrl,
        savedAt,
      );
    }

    database.prepare("DELETE FROM pipelines WHERE project_key = ?").run(projectKey);
    const insertPipeline = database.prepare(`
      INSERT INTO pipelines(
        project_key, pipeline_id, status, ref, sha, updated_at, web_url, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of options.result.pipelines) {
      insertPipeline.run(
        projectKey,
        item.id,
        item.status,
        item.ref,
        item.sha,
        item.updatedAt,
        item.webUrl,
        savedAt,
      );
    }

    database.prepare("DELETE FROM labels WHERE project_key = ?").run(projectKey);
    const insertLabelSnapshot = database.prepare(`
      INSERT INTO labels(
        project_key, name, color, open_issues, closed_issues,
        open_merge_requests, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of options.result.planning.labels) {
      insertLabelSnapshot.run(
        projectKey,
        item.name,
        item.color,
        item.openIssues,
        item.closedIssues,
        item.openMergeRequests,
        savedAt,
      );
    }

    database.prepare("DELETE FROM milestones WHERE project_key = ?").run(projectKey);
    const insertMilestone = database.prepare(`
      INSERT INTO milestones(
        project_key, iid, title, state, start_date, due_date, web_url, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of options.result.planning.milestones) {
      insertMilestone.run(
        projectKey,
        item.iid,
        item.title,
        item.state,
        item.startDate,
        item.dueDate,
        item.webUrl,
        savedAt,
      );
    }

    database.prepare("DELETE FROM iterations WHERE project_key = ?").run(projectKey);
    const insertIteration = database.prepare(`
      INSERT INTO iterations(
        project_key, iid, title, state, start_date, due_date, web_url, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of options.result.planning.iterations) {
      insertIteration.run(
        projectKey,
        item.iid,
        item.title,
        item.state,
        item.startDate,
        item.dueDate,
        item.webUrl,
        savedAt,
      );
    }

    database.prepare(`
      INSERT INTO sync_snapshots(
        snapshot_id, project_key, generated_at, saved_at, source, branch,
        query_json, stats_json, planning_health_json, warnings_json, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        saved_at = excluded.saved_at,
        snapshot_json = excluded.snapshot_json,
        warnings_json = excluded.warnings_json
    `).run(
      snapshotId,
      projectKey,
      options.result.generatedAt,
      savedAt,
      options.result.cache.source,
      options.result.repository.branch,
      JSON.stringify(options.result.query),
      JSON.stringify(options.result.stats),
      JSON.stringify(options.result.planningHealth),
      JSON.stringify(options.result.warnings),
      snapshotJson,
    );
    database.prepare(`
      DELETE FROM sync_snapshots
      WHERE project_key = ? AND snapshot_id NOT IN (
        SELECT snapshot_id FROM sync_snapshots
        WHERE project_key = ? ORDER BY generated_at DESC LIMIT ?
      )
    `).run(projectKey, projectKey, MAX_SYNC_HISTORY);
    setMeta(database, "last_sync_snapshot_id", snapshotId);
    setMeta(database, "last_sync_at", savedAt);
    setMeta(database, "invalidation_at", "");
    setMeta(database, "invalidation_reason", "");
    setMeta(database, "refresh_requested_at", "");
    setMeta(database, "refresh_request_reason", "");
    database.exec("COMMIT");
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function readReadModelStatus(root: string): Promise<ReadModelStatus> {
  const databasePath = localDatabasePath(root);
  const syncJsonPath = join(root, SYNC_JSON_RELATIVE_PATH);
  const databaseExists = await exists(databasePath);
  const syncJsonExists = await exists(syncJsonPath);
  const base = {
    databasePath: LOCAL_DATABASE_RELATIVE_PATH,
    databaseExists,
    expectedSchemaVersion: LOCAL_DATABASE_VERSION,
    cache: {
      database: {
        exists: databaseExists,
        path: LOCAL_DATABASE_RELATIVE_PATH,
        ageSeconds: await ageSecondsForPath(databasePath),
      },
      syncJson: {
        exists: syncJsonExists,
        path: SYNC_JSON_RELATIVE_PATH,
        ageSeconds: await ageSecondsForPath(syncJsonPath),
      },
    },
  };
  if (!databaseExists) {
    return {
      ...base,
      state: "missing",
      schemaVersion: null,
      project: null,
      latestSync: null,
      invalidation: { at: null, reason: null },
      refreshRequest: { at: null, reason: null },
      counts: { workItems: 0, mergeRequests: 0, pipelines: 0, iterations: 0, syncSnapshots: 0 },
    };
  }

  let database;
  try {
    database = await openLocalDatabase(root, { readOnly: true });
    const meta = database.prepare("SELECT key, value FROM oflow_meta").all() as Array<{ key?: unknown; value?: unknown }>;
    const values = new Map(
      meta
        .filter((row) => typeof row.key === "string" && typeof row.value === "string")
        .map((row) => [row.key as string, row.value as string]),
    );
    const schemaVersion = Number(values.get("schema_version"));
    if (!Number.isSafeInteger(schemaVersion)) {
      return {
        ...base,
        state: "invalid",
        schemaVersion: null,
        project: null,
        latestSync: null,
        invalidation: { at: null, reason: null },
        refreshRequest: { at: null, reason: null },
        counts: { workItems: 0, mergeRequests: 0, pipelines: 0, iterations: 0, syncSnapshots: 0 },
      };
    }
    if (schemaVersion > LOCAL_DATABASE_VERSION) {
      return emptyDiagnosticStatus(base, schemaVersion, "unsupported");
    }
    if (schemaVersion < LOCAL_DATABASE_VERSION) {
      return emptyDiagnosticStatus(base, schemaVersion, "migration-required");
    }

    const projectRow = database.prepare(`
      SELECT host, project_path
      FROM projects
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { host?: unknown; project_path?: unknown } | undefined;
    const project = projectRow && typeof projectRow.host === "string" && typeof projectRow.project_path === "string"
      ? { host: projectRow.host, path: projectRow.project_path }
      : null;
    const latest = database.prepare(`
      SELECT generated_at, saved_at, source, branch, stats_json, warnings_json
      FROM sync_snapshots
      ORDER BY generated_at DESC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    const latestSync = latest ? parseLatestSync(latest) : null;
    return {
      ...base,
      state: "ready",
      schemaVersion,
      project,
      latestSync,
      invalidation: {
        at: nullableMeta(values.get("invalidation_at")),
        reason: nullableMeta(values.get("invalidation_reason")),
      },
      refreshRequest: {
        at: nullableMeta(values.get("refresh_requested_at")),
        reason: nullableMeta(values.get("refresh_request_reason")),
      },
      counts: {
        workItems: countRows(database, "work_items"),
        mergeRequests: countRows(database, "merge_requests"),
        pipelines: countRows(database, "pipelines"),
        iterations: countRows(database, "iterations"),
        syncSnapshots: countRows(database, "sync_snapshots"),
      },
    };
  } catch (error: unknown) {
    if (error instanceof OflowError && error.code === "LOCAL_DATABASE_SCHEMA_UNSUPPORTED") {
      return emptyDiagnosticStatus(base, null, "unsupported");
    }
    return {
      ...base,
      state: "invalid",
      schemaVersion: null,
      project: null,
      latestSync: null,
      invalidation: { at: null, reason: null },
      refreshRequest: { at: null, reason: null },
      counts: { workItems: 0, mergeRequests: 0, pipelines: 0, iterations: 0, syncSnapshots: 0 },
    };
  } finally {
    database?.close();
  }
}

export async function readDashboardData(root: string): Promise<DashboardData> {
  const status = await readReadModelStatus(root);
  if (status.state === "missing") {
    return emptyDashboardData(status);
  }
  if (status.state !== "ready") {
    throw new OflowError(
      "The local SQLite read model is not ready (" + status.state + "). Run oflow sync --refresh to migrate or rebuild it.",
      "LOCAL_DATABASE_NOT_READY",
    );
  }
  const database = await openLocalDatabase(root, { readOnly: true });
  try {
    const latest = database.prepare(`
      SELECT snapshot_json
      FROM sync_snapshots
      ORDER BY generated_at DESC
      LIMIT 1
    `).get() as { snapshot_json?: unknown } | undefined;
    const snapshot = latest && typeof latest.snapshot_json === "string"
      ? parseSnapshot(latest.snapshot_json)
      : null;
    const storedWorkItems = snapshot === null ? readStoredWorkItems(database) : [];
    const historyRows = database.prepare(`
      SELECT generated_at, saved_at, source, branch, stats_json, warnings_json
      FROM sync_snapshots
      ORDER BY generated_at DESC
      LIMIT ?
    `).all(20) as Array<Record<string, unknown>>;
    return {
      status,
      project: snapshot?.project ?? null,
      repository: snapshot?.repository ?? null,
      workItems: snapshot?.workItems ?? storedWorkItems,
      mergeRequests: snapshot?.mergeRequests ?? [],
      pipelines: snapshot?.pipelines ?? [],
      iterations: snapshot?.planning.iterations ?? [],
      planning: {
        labels: snapshot?.planning.labels ?? [],
        milestones: snapshot?.planning.milestones ?? [],
        boards: snapshot?.planning.boards ?? [],
      },
      syncHistory: historyRows.map((row) => ({
        generatedAt: stringValue(row.generated_at),
        savedAt: stringValue(row.saved_at),
        source: stringValue(row.source),
        branch: nullableString(row.branch),
        stats: parseJsonObject(row.stats_json) as SyncResult["stats"],
        warningCount: parseJsonArray(row.warnings_json).length,
      })),
    };
  } finally {
    database.close();
  }
}

function readStoredWorkItems(database: DatabaseSync): SyncWorkItem[] {
  const rows = database.prepare(`
    SELECT iid, title, state, web_url, labels_json, assignees_json, milestone,
      iteration, start_date, due_date, weight, task_completed, task_total,
      parent_iid, parent_title, parent_web_url, updated_at
    FROM work_items
    ORDER BY updated_at DESC, iid ASC
    LIMIT 100
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    iid: numberValue(row.iid),
    title: stringValue(row.title),
    state: nullableString(row.state),
    labels: parseJsonStringArray(row.labels_json),
    milestone: nullableString(row.milestone),
    iteration: nullableString(row.iteration),
    assignees: parseJsonStringArray(row.assignees_json),
    startDate: nullableString(row.start_date),
    dueDate: nullableString(row.due_date),
    weight: numberOrNull(row.weight),
    taskCompletion: typeof row.task_completed === "number" && typeof row.task_total === "number"
      ? { completed: row.task_completed, total: row.task_total }
      : null,
    parent: typeof row.parent_title === "string"
      ? {
          iid: numberOrNull(row.parent_iid),
          title: row.parent_title,
          webUrl: nullableString(row.parent_web_url),
        }
      : null,
    updatedAt: nullableString(row.updated_at),
    webUrl: nullableString(row.web_url),
  }));
}

export async function requestReadModelRefresh(root: string, reason = "dashboard"): Promise<boolean> {
  if (!(await exists(localDatabasePath(root)))) {
    return false;
  }
  const database = await openLocalDatabase(root);
  try {
    const requestedAt = new Date().toISOString();
    setMeta(database, "refresh_requested_at", requestedAt);
    setMeta(database, "refresh_request_reason", reason);
    return true;
  } finally {
    database.close();
  }
}

export async function markReadModelStale(root: string, reason: string): Promise<boolean> {
  if (!(await exists(localDatabasePath(root)))) {
    return false;
  }
  const database = await openLocalDatabase(root);
  try {
    setMeta(database, "invalidation_at", new Date().toISOString());
    setMeta(database, "invalidation_reason", reason);
    return true;
  } finally {
    database.close();
  }
}

export function formatReadModelStatusMarkdown(status: ReadModelStatus): string {
  const lines = [
    "# oflow cache status",
    "",
    "Database: " + status.databasePath,
    "State: " + status.state,
    "Schema: " + (status.schemaVersion === null ? "unknown" : String(status.schemaVersion)) +
      "/" + String(status.expectedSchemaVersion),
    "Project: " + (status.project?.path ?? "not synced"),
    "Database age: " + formatStatusAge(status.cache.database.ageSeconds),
    "Sync JSON age: " + formatStatusAge(status.cache.syncJson.ageSeconds),
    "Latest sync: " + (status.latestSync === null
      ? "none"
      : formatStatusAge(status.latestSync.ageSeconds) +
        " (" + String(status.latestSync.warningCount) + " warnings)"),
    "Invalidation: " + (status.invalidation.at
      ? status.invalidation.at + " — " + (status.invalidation.reason ?? "reason unavailable")
      : "clear"),
    "Refresh request: " + (status.refreshRequest.at
      ? status.refreshRequest.at + " — run `oflow sync --refresh`"
      : "none"),
    "Rows: " + String(status.counts.workItems) + " work items, " +
      String(status.counts.mergeRequests) + " merge requests, " +
      String(status.counts.pipelines) + " pipelines, " +
      String(status.counts.iterations) + " iterations, " +
      String(status.counts.syncSnapshots) + " sync snapshots",
    "",
  ];
  return lines.join("\n");
}

function emptyDiagnosticStatus(
  base: Omit<ReadModelStatus, "state" | "schemaVersion" | "project" | "latestSync" | "invalidation" | "refreshRequest" | "counts">,
  schemaVersion: number | null,
  state: ReadModelStatus["state"],
): ReadModelStatus {
  return {
    ...base,
    state,
    schemaVersion,
    project: null,
    latestSync: null,
    invalidation: { at: null, reason: null },
    refreshRequest: { at: null, reason: null },
    counts: { workItems: 0, mergeRequests: 0, pipelines: 0, iterations: 0, syncSnapshots: 0 },
  };
}

function emptyDashboardData(status: ReadModelStatus): DashboardData {
  return {
    status,
    project: null,
    repository: null,
    workItems: [],
    mergeRequests: [],
    pipelines: [],
    iterations: [],
    planning: { labels: [], milestones: [], boards: [] },
    syncHistory: [],
  };
}

function parseSnapshot(value: string): SyncResult | null {
  try {
    const parsed = JSON.parse(value) as Partial<SyncResult>;
    if (!parsed.project || !parsed.repository || !Array.isArray(parsed.workItems) ||
      !Array.isArray(parsed.mergeRequests) || !Array.isArray(parsed.pipelines) ||
      !parsed.planning || !Array.isArray(parsed.planning.iterations)) {
      return null;
    }
    return parsed as SyncResult;
  } catch {
    return null;
  }
}

function parseLatestSync(row: Record<string, unknown>): ReadModelStatus["latestSync"] {
  const generatedAt = stringValue(row.generated_at);
  const savedAt = stringValue(row.saved_at);
  return {
    generatedAt,
    savedAt,
    source: stringValue(row.source),
    ageSeconds: ageSeconds(savedAt),
    branch: nullableString(row.branch),
    stats: parseJsonObject(row.stats_json) as SyncResult["stats"],
    warningCount: parseJsonArray(row.warnings_json).length,
  };
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM " + table).get() as { count?: unknown };
  return typeof row.count === "number" ? row.count : 0;
}

function setMeta(database: DatabaseSync, key: string, value: string): void {
  database.prepare(`
    INSERT INTO oflow_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function nullableMeta(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parseJsonStringArray(value: unknown): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === "string");
}

function makeProjectKey(host: string, projectPath: string): string {
  return host + "\u0000" + projectPath;
}

async function ageSecondsForPath(path: string): Promise<number | null> {
  try {
    const details = await stat(path);
    return ageSeconds(details.mtime.toISOString());
  } catch {
    return null;
  }
}

function ageSeconds(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function formatStatusAge(value: number | null): string {
  if (value === null) {
    return "unavailable";
  }
  if (value < 60) {
    return "under 1 minute";
  }
  const minutes = Math.floor(value / 60);
  if (minutes < 60) {
    return String(minutes) + " minute" + (minutes === 1 ? "" : "s") + " ago";
  }
  const hours = Math.floor(minutes / 60);
  return String(hours) + " hour" + (hours === 1 ? "" : "s") + " ago";
}
