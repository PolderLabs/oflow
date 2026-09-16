import type {
  AcceptanceCriterion,
  CriterionCheck,
  VerificationResult,
} from "./types.js";

export const criterionPattern =
  /^\s*[-*]\s*\[([ xX])\]\s*(?:(?:([A-Za-z]+-\d+))\s*[:.)\-–—]\s*)?(.+?)\s*$/i;

export function acceptanceLines(description: string | null | undefined): string[] {
  const lines = (description ?? "").split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) =>
      /^\s*#{1,6}\s*acceptance criteria\s*:?[ \t]*$/i.test(line) ||
      /^\s*acceptance criteria\s*:?[ \t]*$/i.test(line),
  );
  if (headingIndex < 0) {
    return [];
  }

  const result: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^\s*#{1,6}\s+/.test(lines[index])) {
      break;
    }
    result.push(lines[index]);
  }
  return result;
}

export function parseAcceptanceCriteria(
  description: string | null | undefined,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const usedIds = new Set<string>();
  let nextNumber = 1;

  for (const line of acceptanceLines(description)) {
    const match = line.match(criterionPattern);
    if (!match) {
      continue;
    }

    let id = match[2]?.toUpperCase();
    if (!id || usedIds.has(id)) {
      do {
        id = "AC-" + nextNumber;
        nextNumber += 1;
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    criteria.push({
      id,
      text: match[3].trim(),
      checked: match[1].toLowerCase() === "x",
    });
  }
  return criteria;
}

export function evidenceFromText(text: string | null | undefined): string[] {
  const evidence: string[] = [];
  const pattern = /Evidence\s*:\s*([^\r\n]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text ?? "")) !== null) {
    const value = match[1].trim();
    if (value && !isPlaceholderEvidence(value)) {
      evidence.push(value);
    }
  }
  return evidence;
}

export interface VerificationRecord {
  checked: boolean;
  evidence: string[];
}

export function parseVerificationEvidence(
  description: string | null | undefined,
): Map<string, VerificationRecord> {
  const records = new Map<string, VerificationRecord>();
  let currentId: string | null = null;
  for (const line of (description ?? "").split(/\r?\n/)) {
    const idMatch = line.match(/\b(AC-\d+)\b/i);
    const checkbox = line.match(/^\s*[-*]\s*\[([ xX])\]/);
    if (idMatch) {
      currentId = idMatch[1].toUpperCase();
      const record = records.get(currentId) ?? { checked: false, evidence: [] };
      if (checkbox) {
        record.checked = checkbox[1].toLowerCase() === "x";
      }
      records.set(currentId, record);
    }

    if (!currentId) {
      continue;
    }
    const lineEvidence = evidenceFromText(line);
    if (lineEvidence.length > 0) {
      const record = records.get(currentId) ?? { checked: false, evidence: [] };
      record.evidence.push(...lineEvidence);
      records.set(currentId, record);
    }
  }
  return records;
}

export function evaluateCriteria(
  criteria: AcceptanceCriterion[],
  mergeRequestDescription: string | null | undefined,
  pipelineStatus: string | null | undefined,
): VerificationResult {
  const records = parseVerificationEvidence(mergeRequestDescription);
  const reasons: string[] = [];
  const checks: CriterionCheck[] = criteria.map((criterion) => {
    const record = records.get(criterion.id);
    const checked = record?.checked ?? false;
    const evidence = record?.evidence ?? [];
    const failures: string[] = [];
    if (!record || !checked) {
      failures.push("MR checklist item is not checked");
    }
    if (evidence.length === 0) {
      failures.push("missing non-placeholder Evidence: line");
    }
    const reason = failures.length === 0 ? "verified" : failures.join("; ");
    const check: CriterionCheck = {
      ...criterion,
      checked,
      evidence,
      verified: failures.length === 0,
      reason,
    };
    if (!check.verified) {
      reasons.push(criterion.id + ": " + reason);
    }
    return check;
  });

  if (criteria.length === 0) {
    reasons.unshift("story has no Acceptance criteria checklist");
  }

  const normalizedPipelineStatus = pipelineStatus?.toLowerCase() ?? null;
  if (normalizedPipelineStatus !== "success") {
    reasons.push(
      "latest pipeline is " + (pipelineStatus ?? "unknown") + "; expected success",
    );
  }

  return {
    passed: criteria.length > 0 && checks.every((check) => check.verified) && normalizedPipelineStatus === "success",
    pipelineStatus: pipelineStatus ?? null,
    checks,
    reasons,
  };
}

function isPlaceholderEvidence(value: string): boolean {
  return /^(?:tbd|todo|none|n\/?a|pending|not available|-)$/i.test(value) ||
    /^(?:tbd|todo)\b/i.test(value);
}
