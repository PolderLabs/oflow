import { createHash } from "node:crypto";
import { OflowError } from "./errors.js";
import { openLocalDatabase } from "./sqlite.js";
import type { GitLabPagination } from "./gitlab.js";
import type { WorkItemSummary } from "./context.js";
import type { GitLabIssueFilters, IssueState, LocalWorkCacheQuery } from "./types.js";

export interface WorkCacheResult {
  items: WorkItemSummary[];
  pagination: GitLabPagination;
  workItemsMayBeTruncated: boolean;
  cache: {
    source: "sqlite";
    savedAt: string;
    ageSeconds: number;
    actorUsername: string | null;
  };
}

export interface WorkCacheSaveResult {
  savedAt: string;
  actorUsername: string | null;
}

export function normalizeWorkCacheQuery(query: LocalWorkCacheQuery): LocalWorkCacheQuery {
  return {
    state: query.state,
    issueLimit: query.issueLimit,
    issueFilters: Object.fromEntries(
      Object.entries(query.issueFilters)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    mine: query.mine,
  };
}

export function workCacheKey(
  host: string,
  projectPath: string,
  query: LocalWorkCacheQuery,
): string {
  const projectKey = makeProjectKey(host, projectPath);
  const normalized = normalizeWorkCacheQuery(query);
  return createHash("sha256")
    .update(JSON.stringify({ projectKey, query: normalized }))
    .digest("hex");
}

export async function saveWorkItemsCache(options: {
  root: string;
  host: string;
  projectPath: string;
  query: LocalWorkCacheQuery;
  actorUsername: string | null;
  items: WorkItemSummary[];
  pagination: GitLabPagination;
}): Promise<WorkCacheSaveResult> {
  const query = normalizeWorkCacheQuery(options.query);
  const projectKey = makeProjectKey(options.host, options.projectPath);
  const cacheKey = workCacheKey(options.host, options.projectPath, query);
  const savedAt = new Date().toISOString();
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

    for (const item of options.items) {
      const taskCompleted = item.taskCompletion?.completed ?? null;
      const taskTotal = item.taskCompletion?.total ?? null;
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
        taskCompleted,
        taskTotal,
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

    database.prepare(`
      INSERT INTO work_item_cache_queries(
        cache_key, project_key, query_json, state, issue_limit, mine,
        actor_username, saved_at, work_items_may_be_truncated, pagination_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        project_key = excluded.project_key,
        query_json = excluded.query_json,
        state = excluded.state,
        issue_limit = excluded.issue_limit,
        mine = excluded.mine,
        actor_username = excluded.actor_username,
        saved_at = excluded.saved_at,
        work_items_may_be_truncated = excluded.work_items_may_be_truncated,
        pagination_json = excluded.pagination_json
    `).run(
      cacheKey,
      projectKey,
      JSON.stringify(query),
      query.state,
      query.issueLimit,
      query.mine ? 1 : 0,
      options.actorUsername,
      savedAt,
      options.pagination.hasNextPage ? 1 : 0,
      JSON.stringify(options.pagination),
    );
    database.prepare("DELETE FROM work_item_cache_items WHERE cache_key = ?").run(cacheKey);
    const insertCacheItem = database.prepare(`
      INSERT INTO work_item_cache_items(cache_key, position, project_key, iid, item_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    options.items.forEach((item, position) => {
      insertCacheItem.run(cacheKey, position, projectKey, item.iid, JSON.stringify(item));
    });
    database.exec("COMMIT");
    return { savedAt, actorUsername: options.actorUsername };
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

export async function readWorkItemsCache(options: {
  root: string;
  host: string;
  projectPath: string;
  query: LocalWorkCacheQuery;
}): Promise<WorkCacheResult> {
  const query = normalizeWorkCacheQuery(options.query);
  const projectKey = makeProjectKey(options.host, options.projectPath);
  const cacheKey = workCacheKey(options.host, options.projectPath, query);
  let database;
  try {
    database = await openLocalDatabase(options.root, { readOnly: true });
  } catch (error: unknown) {
    if (error instanceof OflowError && error.code === "LOCAL_DATABASE_MISS") {
      throw new OflowError(
        "No local work-item cache exists. Run oflow work --refresh first.",
        "WORK_CACHE_MISS",
      );
    }
    throw error;
  }

  try {
    const row = database.prepare(`
      SELECT saved_at, actor_username, work_items_may_be_truncated, pagination_json
      FROM work_item_cache_queries
      WHERE cache_key = ? AND project_key = ? AND query_json = ?
    `).get(cacheKey, projectKey, JSON.stringify(query)) as {
      saved_at?: unknown;
      actor_username?: unknown;
      work_items_may_be_truncated?: unknown;
      pagination_json?: unknown;
    } | undefined;
    if (!row || typeof row.saved_at !== "string" || typeof row.pagination_json !== "string") {
      throw new OflowError(
        "No matching local work-item cache exists. Run oflow work --refresh with the requested filters.",
        "WORK_CACHE_MISS",
      );
    }

    let pagination: GitLabPagination;
    try {
      pagination = parsePagination(JSON.parse(row.pagination_json));
    } catch {
      throw new OflowError(
        "The local work-item cache is invalid. Run oflow work --refresh to replace it.",
        "WORK_CACHE_INVALID",
      );
    }
    const rows = database.prepare(`
      SELECT item_json
      FROM work_item_cache_items
      WHERE cache_key = ?
      ORDER BY position ASC
    `).all(cacheKey) as Array<{ item_json?: unknown }>;
    const items = rows.map((item) => parseWorkItem(item.item_json));
    return {
      items,
      pagination,
      workItemsMayBeTruncated: row.work_items_may_be_truncated === 1,
      cache: {
        source: "sqlite",
        savedAt: row.saved_at,
        ageSeconds: cacheAgeSeconds(row.saved_at),
        actorUsername: typeof row.actor_username === "string" ? row.actor_username : null,
      },
    };
  } finally {
    database.close();
  }
}

function makeProjectKey(host: string, projectPath: string): string {
  return host + "\u0000" + projectPath;
}

function cacheAgeSeconds(savedAt: string): number {
  const timestamp = Date.parse(savedAt);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function parsePagination(value: unknown): GitLabPagination {
  if (!isRecord(value) || typeof value.returned !== "number" ||
    typeof value.requested !== "number" || typeof value.hasNextPage !== "boolean") {
    throw new Error("invalid pagination");
  }
  return value as unknown as GitLabPagination;
}

function parseWorkItem(value: unknown): WorkItemSummary {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || typeof parsed.iid !== "number" || typeof parsed.title !== "string" ||
    !Array.isArray(parsed.labels) || !Array.isArray(parsed.assignees)) {
    throw new OflowError(
      "The local work-item cache is invalid. Run oflow work --refresh to replace it.",
      "WORK_CACHE_INVALID",
    );
  }
  return parsed as unknown as WorkItemSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
