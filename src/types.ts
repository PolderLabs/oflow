export type AgentName = "claude" | "codex";

export type AgentMode = AgentName | "both" | "unknown";

export type IssueState = "opened" | "closed" | "all";

export interface GitLabIssueFilters {
  label?: string;
  milestone?: string;
  assignee?: string;
  search?: string;
  updatedAfter?: string;
}

export type FileAction = "created" | "updated" | "unchanged" | "skipped";

export interface AgentDetection {
  mode: AgentMode;
  claude: boolean;
  codex: boolean;
  signals: Record<AgentName, string[]>;
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
  agent: {
    mode: AgentMode;
    claude: boolean;
    codex: boolean;
  };
  workflow: {
    storyType: "issue";
    acceptanceCriteriaRequired: true;
    requireEvidenceInMergeRequest: true;
    requireSuccessfulPipeline: true;
  };
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  checked: boolean;
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
  epic?: Record<string, unknown> | null;
  parent?: Record<string, unknown> | null;
  references?: Record<string, unknown> | null;
  updated_at?: string;
  created_at?: string;
  due_date?: string | null;
  weight?: number | null;
  [key: string]: unknown;
}

export interface GitLabIssueUpdate {
  title?: string;
  description?: string;
  labels?: string;
  milestone?: string;
  epic_id?: number;
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
  source_branch?: string;
  target_branch?: string;
  draft?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GitLabPipeline {
  id: number;
  status?: string;
  ref?: string;
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

export interface DoctorReport {
  root: string;
  remote: GitLabRemote | null;
  configFound: boolean;
  agent: AgentDetection;
  tokenConfigured: boolean;
  tokenSource: "environment" | "stored" | null;
  apiCheck: "not-requested" | "skipped" | "passed" | "failed";
  requiredFiles: Array<{ path: string; present: boolean }>;
  warnings: string[];
}
