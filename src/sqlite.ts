import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OflowError } from "./errors.js";
import { exists } from "./fs.js";

export const LOCAL_DATABASE_VERSION = 2;
export const LOCAL_DATABASE_RELATIVE_PATH = ".oflow/cache/oflow.db";

export interface LocalDatabaseOptions {
  readOnly?: boolean;
}

export function localDatabasePath(root: string): string {
  return join(root, LOCAL_DATABASE_RELATIVE_PATH);
}

export async function openLocalDatabase(
  root: string,
  options: LocalDatabaseOptions = {},
): Promise<DatabaseSync> {
  const path = localDatabasePath(root);
  if (options.readOnly && !(await exists(path))) {
    throw new OflowError(
      "No local SQLite cache exists at " + LOCAL_DATABASE_RELATIVE_PATH + ". Run a live work or sync read first.",
      "LOCAL_DATABASE_MISS",
    );
  }

  if (!options.readOnly) {
    await mkdir(join(root, ".oflow", "cache"), { recursive: true });
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, {
      readOnly: options.readOnly === true,
      timeout: 5000,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OflowError(
      "Could not open the local SQLite database: " + message,
      "LOCAL_DATABASE_OPEN_FAILED",
    );
  }

  try {
    if (!options.readOnly) {
      migrate(database);
      // Cache data never contains credentials, but keep the database private to
      // the current user when the repository's umask is permissive.
      await chmod(path, 0o600);
    }
    return database;
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS oflow_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const current = database
    .prepare("SELECT value FROM oflow_meta WHERE key = 'schema_version'")
    .get() as { value?: unknown } | undefined;
  const version = current?.value === undefined ? 0 : Number(current.value);
  if (!Number.isSafeInteger(version) || version > LOCAL_DATABASE_VERSION) {
    throw new OflowError(
      "The local SQLite database uses an unsupported schema version.",
      "LOCAL_DATABASE_SCHEMA_UNSUPPORTED",
    );
  }

  if (version < 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        project_path TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(host, project_path)
      );

      CREATE TABLE IF NOT EXISTS work_items (
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT,
        web_url TEXT,
        labels_json TEXT NOT NULL,
        assignees_json TEXT NOT NULL,
        milestone TEXT,
        iteration TEXT,
        start_date TEXT,
        due_date TEXT,
        weight INTEGER,
        task_completed INTEGER,
        task_total INTEGER,
        parent_iid INTEGER,
        parent_title TEXT,
        parent_web_url TEXT,
        updated_at TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(project_key, iid),
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS work_items_state_idx
        ON work_items(project_key, state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS work_items_updated_idx
        ON work_items(project_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS work_item_labels (
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY(project_key, iid, label),
        FOREIGN KEY(project_key, iid) REFERENCES work_items(project_key, iid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS work_item_labels_lookup_idx
        ON work_item_labels(project_key, label, iid);

      CREATE TABLE IF NOT EXISTS work_item_assignees (
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY(project_key, iid, username),
        FOREIGN KEY(project_key, iid) REFERENCES work_items(project_key, iid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS work_item_assignees_lookup_idx
        ON work_item_assignees(project_key, username, iid);

      CREATE TABLE IF NOT EXISTS work_item_cache_queries (
        cache_key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        query_json TEXT NOT NULL,
        state TEXT NOT NULL,
        issue_limit INTEGER NOT NULL,
        mine INTEGER NOT NULL,
        actor_username TEXT,
        saved_at TEXT NOT NULL,
        work_items_may_be_truncated INTEGER NOT NULL,
        pagination_json TEXT NOT NULL,
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS work_item_cache_queries_project_idx
        ON work_item_cache_queries(project_key, saved_at DESC);

      CREATE TABLE IF NOT EXISTS work_item_cache_items (
        cache_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY(cache_key, position),
        FOREIGN KEY(cache_key) REFERENCES work_item_cache_queries(cache_key) ON DELETE CASCADE,
        FOREIGN KEY(project_key, iid) REFERENCES work_items(project_key, iid) ON DELETE CASCADE
      );

      INSERT INTO oflow_meta(key, value) VALUES ('schema_version', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }

  if (version < 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS merge_requests (
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT,
        draft INTEGER NOT NULL,
        source_branch TEXT,
        target_branch TEXT,
        updated_at TEXT,
        web_url TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(project_key, iid),
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS merge_requests_state_idx
        ON merge_requests(project_key, state, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pipelines (
        project_key TEXT NOT NULL,
        pipeline_id INTEGER NOT NULL,
        status TEXT,
        ref TEXT,
        sha TEXT,
        updated_at TEXT,
        web_url TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(project_key, pipeline_id),
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS pipelines_status_idx
        ON pipelines(project_key, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS labels (
        project_key TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        open_issues INTEGER,
        closed_issues INTEGER,
        open_merge_requests INTEGER,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(project_key, name),
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS milestones (
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT,
        start_date TEXT,
        due_date TEXT,
        web_url TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(project_key, iid),
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS iterations (
        project_key TEXT NOT NULL,
        iid INTEGER NOT NULL,
        title TEXT,
        state TEXT,
        start_date TEXT,
        due_date TEXT,
        web_url TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(project_key, iid),
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS iterations_state_idx
        ON iterations(project_key, state, start_date, due_date);

      CREATE TABLE IF NOT EXISTS sync_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        source TEXT NOT NULL,
        branch TEXT,
        query_json TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        planning_health_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        FOREIGN KEY(project_key) REFERENCES projects(project_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS sync_snapshots_project_idx
        ON sync_snapshots(project_key, generated_at DESC);

      INSERT INTO oflow_meta(key, value) VALUES ('schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }
}
