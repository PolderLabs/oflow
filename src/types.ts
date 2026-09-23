import type { BackendStatus } from "./backends.js";

export type AgentName = "claude" | "codex" | "omp";

export type AgentMode = AgentName | "both" | "unknown";

export type IssueState = "opened" | "closed" | "all";

export type IterationState = "opened" | "upcoming" | "current" | "closed" | "all";

export const issueTypes = ["issue", "incident", "test_case", "task"] as const;

export type IssueType = (typeof issueTypes)[number];

export function isIssueType(value: unknown): value is IssueType {
  return typeof value === "string" &&
    (issueTypes as readonly string[]).includes(value);
}

export interface GitLabIssueFilters {
  label?: string;
  milestone?: string;
  iteration?: string;
  epic?: string;
  assignee?: string;
  author?: string;
  search?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

export type FileAction = "created" | "updated" | "unchanged" | "skipped";

export interface AgentDetection {
  mode: AgentMode;
  claude: boolean;
  codex: boolean;
  omp: boolean;
  signals: Record<AgentName, string[]>;
}

/** Backend label used by per-capability probe results. */
export type AuthCapabilityBackend =
  | "glab"
  | "rest"
  | "graphql"
  | "gitlab-mcp"
  | "none";

/** F2 snapshot: whether a capability can be satisfied by the resolved transport. */
export interface AuthCapability {
  id: string;
  usable: boolean;
  probe:
    | "passed"
    | "failed"
    | "forbidden"
    | "unavailable"
    | "skipped"
    | "not-probed";
  backend: AuthCapabilityBackend;
  source?: string;
  reason?: string;
  remediation?: string;
}

export interface GitLabRemote {
  host: string;
  projectPath: string;
  remoteUrl: string;
}

export interface OflowConfig {
  managedBy: "oflow";
  version: 1;
  project: {
    host: string;
    path: string;
  };
  agent: OflowConfigAgentSection;
  workflow: {
    storyType: "issue";
    acceptanceCriteriaRequired: true;
    requireEvidenceInMergeRequest: true;
    requireSuccessfulPipeline: true;
    /**
     * F4 pipeline policy: "enabled" requires success when pipeline evidence
     * exists; missing evidence without CI config is a warning. "disabled"
     * skips the pipeline gate with explicit policy output.
     */
    pipeline?: "enabled" | "disabled";
  };
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  checked: boolean;
}

export interface OflowConfigAgentSection {
  mode: AgentMode;
  claude: boolean;
  codex: boolean;
  omp: boolean;
}

export interface CriterionCheck extends AcceptanceCriterion {
  verified: boolean;
  evidence: string[];
  reason: string;
}

export interface VerificationResult {
  passed: boolean;
  pipelineStatus: string | null;
  checks: CriterionCheck[];
  reasons: string[];
}

export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch?: string | null;
  description?: string | null;
  namespace?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  labels?: string[];
  assignees?: Array<Record<string, unknown>>;
  author?: Record<string, unknown> | null;
  milestone?: Record<string, unknown> | null;
  iteration?: Record<string, unknown> | null;
  epic?: Record<string, unknown> | null;
  parent?: Record<string, unknown> | null;
  issue_type?: string;
  references?: Record<string, unknown> | null;
  updated_at?: string;
  created_at?: string;
  start_date?: string | null;
  due_date?: string | null;
  weight?: number | null;
  task_completion_status?: {
    count?: number;
    completed_count?: number;
  } | null;
  [key: string]: unknown;
}

export interface GitLabIssueUpdate {
  title?: string;
  description?: string;
  labels?: string;
  add_labels?: string;
  remove_labels?: string;
  milestone?: string;
  milestone_id?: number;
  epic_id?: number;
  issue_type?: IssueType;
  due_date?: string;
  weight?: number;
  assignee_ids?: number[];
  state_event?: "close" | "reopen";
}

export interface GitLabIssueCreate {
  title: string;
  description?: string;
  labels?: string;
  milestone?: string;
  epic_id?: number;
  issue_type?: IssueType;
  due_date?: string;
  weight?: number;
  assignee_ids?: number[];
}

export interface GitLabUser {
  id: number;
  username: string;
  name?: string;
  state?: string;
  web_url?: string;
  [key: string]: unknown;
}

export interface LocalWorkCacheQuery {
  state: IssueState;
  issueLimit: number;
  issueFilters: GitLabIssueFilters;
  mine: boolean;
}

export interface GitLabNoteCreate {
  body: string;
}

export interface GitLabLabelCreate {
  name: string;
  color: string;
  description?: string;
}

export interface GitLabLabelUpdate {
  new_name?: string;
  color?: string;
  description?: string;
}

export interface GitLabMilestoneCreate {
  title: string;
  description?: string;
  start_date?: string;
  due_date?: string;
}

export interface GitLabMilestoneUpdate {
  title?: string;
  description?: string;
  start_date?: string;
  due_date?: string;
  state_event?: "close" | "activate";
}

export interface GitLabLabel {
  id?: number;
  name: string;
  color?: string;
  description?: string | null;
  open_issues_count?: number;
  closed_issues_count?: number;
  open_merge_requests_count?: number;
  [key: string]: unknown;
}

export interface GitLabMilestone {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state?: string;
  start_date?: string | null;
  due_date?: string | null;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GitLabBoard {
  id: number;
  name: string;
  lists?: GitLabBoardList[];
  [key: string]: unknown;
}

export interface GitLabBoardCreate {
  name: string;
}

export interface GitLabBoardUpdate {
  name?: string;
  hide_backlog_list?: boolean;
  hide_closed_list?: boolean;
}

export interface GitLabBoardListCreate {
  label_id: number;
}

export interface GitLabBoardListUpdate {
  position: number;
}

export interface GitLabBoardList {
  id: number;
  label?: { id?: number; name?: string; color?: string } | null;
  position?: number;
  [key: string]: unknown;
}

export interface GitLabIteration {
  id: number;
  iid: number;
  title?: string | null;
  description?: string | null;
  state?: string;
  start_date?: string | null;
  due_date?: string | null;
  web_url?: string;
  [key: string]: unknown;
}

export interface GitLabIterationCadence {
  id: string;
  title?: string | null;
  active?: boolean | null;
  automatic?: boolean | null;
  duration_in_weeks?: number | null;
  iterations_in_advance?: number | null;
  roll_over?: boolean | null;
  start_date?: string | null;
  [key: string]: unknown;
}

export interface GitLabWorkItemReference {
  id: string | null;
  iid: number | null;
  title: string;
  web_url: string | null;
  type: string | null;
}

export interface GitLabGroupEpic {
  id: string;
  iid: number;
  title: string;
  state: string | null;
  web_url: string | null;
}

export interface GitLabGroupEpicDetail extends GitLabGroupEpic {
  parent: GitLabWorkItemReference | null;
  children: GitLabWorkItemReference[];
}

export interface GitLabNote {
  id: number;
  body: string;
  author?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  author?: Record<string, unknown> | null;
  assignees?: Array<Record<string, unknown>>;
  reviewers?: Array<Record<string, unknown>>;
  labels?: string[];
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  diff_refs?: Record<string, unknown> | null;
  head_pipeline?: Record<string, unknown> | null;
  draft?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  pipeline?: Record<string, unknown> | null;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GitLabPipeline {
  id: number;
  status?: string;
  ref?: string;
  source?: string;
  web_url?: string;
  sha?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface StoryContext {
  generatedAt: string;
  branch: string | null;
  project: GitLabProject;
  story: GitLabIssue;
  epic: Record<string, unknown> | null;
  criteria: AcceptanceCriterion[];
  mergeRequests: GitLabMergeRequest[];
  pipelines: GitLabPipeline[];
  mergeRequestPipelines?: GitLabPipeline[];
  recentNotes: GitLabNote[];
  warnings: string[];
}

export interface InstallFileChange {
  path: string;
  action: FileAction;
  detail: string;
}

export interface InstallResult {
  root: string;
  remote: GitLabRemote;
  detection: AgentDetection;
  files: InstallFileChange[];
  warnings: string[];
}

export type DoctorCheckStatus = "passed" | "failed" | "skipped" | "not-probed";

export interface DoctorCapabilityCheck {
  id: string;
  access: "read" | "write";
  backend: "REST" | "GraphQL" | "REST + GraphQL" | "glab" | "MCP";
  status: DoctorCheckStatus;
  required: boolean;
  detail: string;
  latencyMs?: number;
}

export interface DoctorReport {
  root: string;
  remote: GitLabRemote | null;
  configFound: boolean;
  agent: AgentDetection;
  tokenConfigured: boolean;
  tokenSource: "environment" | "stored" | null;
  apiCheck: "not-requested" | "skipped" | "passed" | "failed";
  apiChecks: DoctorCapabilityCheck[];
  /** F2: per-capability usability snapshot from the auth resolver (present with --check-api). */
  capabilities?: AuthCapability[];
  backends: BackendStatus;
  requiredFiles: Array<{ path: string; present: boolean }>;
  warnings: string[];
  /**
   * Slice A 5-state transport lifecycle for the probed host. Present only
   * when `--check-api` was passed and a remote was resolved. Distinct from
   * `capabilities` (per-capability F2 snapshot): `transport` answers "is
   * the host reachable end-to-end?" while `capabilities` answers "what
   * can each capability do?"
   */
  transport?: {
    host: string;
    state: {
      configured: boolean;
      authenticated: boolean | "runtime-owned";
      readable: boolean;
      mutable: boolean | "runtime-owned" | "unsupported";
      verifiable: boolean | "runtime-owned" | "unsupported";
    };
    reduced: boolean;
  };
}

/** One discovered credential source for a GitLab host; never token material. */
export interface GitLabAuthCandidate {
  host: string;
  source:
    | "mcp-runtime"
    | "glab"
    | "environment"
    | "oflow-store"
    | "ci-job-token";
  authenticated: boolean | "runtime-owned";
  interactive: boolean;
  backendCompatibility: string[];
  user?: string;
  notes?: string[];
}
