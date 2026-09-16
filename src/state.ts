import { join } from "node:path";
import { getCurrentBranch } from "./git.js";
import { loadConfig } from "./config.js";
import { readJson, writeJson } from "./fs.js";
import { OflowError } from "./errors.js";

export const SESSION_RELATIVE_PATH = ".oflow/state/session.json";

export interface OflowSession {
  storyIid: number;
  projectPath: string;
  branch: string | null;
  startedAt: string;
}

export async function startSession(
  root: string,
  storyIid: number,
): Promise<OflowSession> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const session: OflowSession = {
    storyIid,
    projectPath: config.project.path,
    branch: await getCurrentBranch(root),
    startedAt: new Date().toISOString(),
  };
  await writeJson(join(root, SESSION_RELATIVE_PATH), session);
  return session;
}

export async function resolveStoryIid(
  root: string,
  explicit?: string,
): Promise<number> {
  const candidates = [
    explicit,
    process.env.OFLOW_STORY,
    (await readJson<OflowSession>(join(root, SESSION_RELATIVE_PATH)))?.storyIid?.toString(),
  ];
  for (const candidate of candidates) {
    if (candidate && /^\d+$/.test(candidate.trim())) {
      const iid = Number(candidate.trim());
      if (Number.isSafeInteger(iid) && iid > 0) {
        return iid;
      }
    }
  }

  const branch = await getCurrentBranch(root);
  const match = branch?.match(
    /(?:^|[/_-])(?:story|feature|fix|chore)[/_-]?(\d+)(?:$|[/_-])/i,
  );
  if (match) {
    return Number(match[1]);
  }

  throw new OflowError(
    "No story IID found. Pass --story <iid>, set OFLOW_STORY, or use a story/42 branch.",
    "MISSING_STORY",
  );
}
