import { join } from "node:path";
import { readJson } from "./fs.js";
import type { PipelinePolicy } from "./criteria.js";
import type { AgentDetection, GitLabRemote, OflowConfig } from "./types.js";

export type { PipelinePolicy };

export const OFLOW_DIRECTORY = ".oflow";
export const CONFIG_RELATIVE_PATH = OFLOW_DIRECTORY + "/config.json";

export function configPath(root: string): string {
  return join(root, CONFIG_RELATIVE_PATH);
}

export async function loadConfig(root: string): Promise<OflowConfig | null> {
  return readJson<OflowConfig>(configPath(root));
}

export function makeConfig(
  remote: GitLabRemote,
  detection: AgentDetection,
): OflowConfig {
  return {
    managedBy: "oflow",
    version: 1,
    project: {
      host: remote.host,
      path: remote.projectPath,
    },
    agent: {
      mode: detection.mode,
      claude: detection.claude,
      codex: detection.codex,
      omp: detection.omp,
    },
    workflow: {
      storyType: "issue",
      acceptanceCriteriaRequired: true,
      requireEvidenceInMergeRequest: true,
      requireSuccessfulPipeline: true,
      pipeline: "enabled",
    },
  };
}

export function resolvePipelinePolicy(config: OflowConfig | null): PipelinePolicy {
  const value = config?.workflow?.pipeline;
  return value === "disabled" ? "disabled" : "enabled";
}
