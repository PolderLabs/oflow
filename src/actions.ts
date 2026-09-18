/**
 * Backend-neutral canonical action vocabulary (vNext architecture, PR 1).
 *
 * An oflow plan describes intent, not transport: no backend, no token, no
 * MCP server name, no glab command. Backend selection happens at execution
 * time through the ExecutionBackend registry.
 */

/** Planning actions that operate on GitLab issues/work items. */
export const WORK_ITEM_ACTIONS = [
  "work_item.create",
  "work_item.update",
  "work_item.comment",
  "work_item.close",
  "work_item.reopen",
  "work_item.assign",
  "work_item.set_milestone",
  "work_item.set_iteration",
  "work_item.add_labels",
  "work_item.remove_labels",
  "work_item.set_parent",
] as const;

/** Delivery actions, deferred until the agent execution layer is proven. */
export const DELIVERY_ACTIONS = [
  "merge_request.create",
  "merge_request.update",
  "merge_request.comment",
  "merge_request.request_review",
  "merge_request.merge",
  "pipeline.run",
  "pipeline.retry",
  "pipeline.cancel",
] as const;

/** Local workflow actions owned entirely by oflow. */
export const LOCAL_WORKFLOW_ACTIONS = [
  "workflow.start",
  "workflow.assess",
  "workflow.plan",
  "workflow.approve",
  "workflow.verify",
  "workflow.finish",
  "workflow.handoff",
] as const;

export type WorkItemActionName = (typeof WORK_ITEM_ACTIONS)[number];
export type DeliveryActionName = (typeof DELIVERY_ACTIONS)[number];
export type LocalWorkflowActionName = (typeof LOCAL_WORKFLOW_ACTIONS)[number];

export type CanonicalActionName =
  | WorkItemActionName
  | DeliveryActionName
  | LocalWorkflowActionName;

export function isCanonicalActionName(value: string): value is CanonicalActionName {
  return (
    WORK_ITEM_ACTIONS.includes(value as WorkItemActionName) ||
    DELIVERY_ACTIONS.includes(value as DeliveryActionName) ||
    LOCAL_WORKFLOW_ACTIONS.includes(value as LocalWorkflowActionName)
  );
}

/** Target of a remote GitLab action, normalized across transports. */
export interface CanonicalActionTarget {
  host: string;
  projectPath: string;
  iid?: number;
}

/**
 * Capability requirement attached to a plan. Backends declare support for
 * capability ids; the executor refuses to run when no backend satisfies it.
 */
export interface CapabilityRequirement {
  capability: string;
  permission?: string;
}

/** Remote-state precondition guarding against stale writes. */
export interface RemotePrecondition {
  updatedAt?: string;
}

/** A canonical action plus everything needed to plan, gate, and verify it. */
export interface CanonicalAction<TDesired = unknown, TResult = unknown> {
  action: CanonicalActionName;
  target: CanonicalActionTarget;
  desiredState: TDesired;
  preconditions?: RemotePrecondition;
  requirements: CapabilityRequirement[];
  policy: {
    approval: "required" | "not-required";
    destructive: boolean;
  };
}

/**
 * Contract every execution backend implements. Adapters translate an
 * approved canonical action into transport-specific calls; oflow keeps
 * policy, approval, and verification.
 */
export interface ExecutionBackend {
  id: "rest" | "graphql" | "glab" | "gitlab-mcp";
  availability(): Promise<BackendAvailability>;
  supports(action: CanonicalActionName): boolean;
}

export type BackendAvailability =
  | {
      available: true;
      authenticated: boolean;
      capabilities: string[];
    }
  | {
      available: false;
      authenticated: false;
      capabilities: string[];
      reason: string;
    };

/** Delegated execution: runtime-owned MCP tool call, verified by oflow. */
export interface DelegatedActionRequest {
  execution: "delegated";
  backendPreference: "gitlab-mcp";
  action: {
    name: CanonicalActionName;
    arguments: Record<string, unknown>;
  };
  afterExecution: {
    command: string;
  };
}

/** Evidence produced when a backend executes an approved action. */
export interface ExecutionReceipt<TResult = unknown> {
  backend: "rest" | "graphql" | "glab" | "gitlab-mcp";
  action: CanonicalActionName;
  executedAt: string;
  success: boolean;
  result?: TResult;
  error?: string;
}

/** Independent postcondition verification, never a trusted success response. */
export interface PostconditionVerification {
  action: CanonicalActionName;
  verifiedAt: string;
  passed: boolean;
  checks: Array<{ description: string; passed: boolean }>;
}

/** Contract each action handler implements for semantics + verification. */
export interface ActionHandler<TPlan, TResult> {
  validate(plan: TPlan): Promise<void>;
  requiredCapabilities(plan: TPlan): CapabilityRequirement[];
  verify(plan: TPlan, result: TResult): Promise<PostconditionVerification>;
}
