import type {
  AcceptanceCriterion,
  CriterionCheck,
  VerificationResult,
} from "./types.js";

export const criterionPattern =
  /^\s*[-*]\s*\[([ xX])\]\s*(?:(?:([A-Za-z]+-\d+))\s*[:.)\-–—]\s*)?(.+?)\s*$/i;

/** Plain bullet under a fallback acceptance heading (no checkbox yet). */
export const plainBulletPattern = /^\s*[-*]\s+(?![([])(.+?)\s*$/;

const ACCEPTANCE_HEADINGS: Array<{
  test: (line: string) => boolean;
  source: "acceptance-criteria" | "done-when" | "equivalent";
}> = [
  { test: isAcceptanceHeading, source: "acceptance-criteria" },
  { test: isDoneWhenHeading, source: "done-when" },
  { test: isEquivalentBulletHeading, source: "equivalent" },
];

export interface AcceptanceSection {
  heading: string;
  source: "acceptance-criteria" | "done-when" | "equivalent";
  lines: string[];
}

function findAcceptanceSections(description: string | null | undefined): AcceptanceSection[] {
  const lines = normalizeDescription(description).split(/\r?\n/);
  const sections: AcceptanceSection[] = [];
  let primary: AcceptanceSection | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const match = ACCEPTANCE_HEADINGS.find((entry) => entry.test(lines[index]));
    if (!match) {
      continue;
    }
    const sectionLines: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (isSectionHeading(lines[next]) || ACCEPTANCE_HEADINGS.some((entry) => entry.test(lines[next]))) {
        break;
      }
      sectionLines.push(lines[next]);
    }
    const section: AcceptanceSection = {
      heading: lines[index].trim(),
      source: match.source,
      lines: sectionLines,
    };
    if (match.source === "acceptance-criteria") {
      // An explicit Acceptance criteria heading wins; ignore fallbacks.
      primary = section;
      break;
    }
    if (!primary) {
      primary = section;
    }
  }
  return primary ? [primary] : [];
}

export function acceptanceLines(description: string | null | undefined): string[] {
  return findAcceptanceSections(description)[0]?.lines ?? [];
}

export function acceptanceSectionSource(
  description: string | null | undefined,
): AcceptanceSection["source"] | null {
  return findAcceptanceSections(description)[0]?.source ?? null;
}

export function parseAcceptanceCriteria(
  description: string | null | undefined,
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const usedIds = new Set<string>();
  let nextNumber = 1;
  const section = findAcceptanceSections(description)[0];

  for (const line of section?.lines ?? []) {
    const match = line.match(criterionPattern);
    let id: string | undefined;
    let text: string | undefined;
    let checked = false;

    if (match) {
      id = match[2]?.toUpperCase();
      text = match[3].trim();
      checked = match[1].toLowerCase() === "x";
    } else if (section && section.source !== "acceptance-criteria") {
      // Conservative: under Done when / equivalent headings only, treat plain
      // bullets as unchecked criteria so agents still see explicit scope.
      const plain = line.match(plainBulletPattern);
      if (plain) {
        text = plain[1].trim().replace(/^(?:AC-\d+)\s*[:.)\-–—]\s*/i, "");
        const explicitId = /^(?:AC-\d+)\b/i.exec(plain[1])?.[0];
        if (explicitId) {
          id = explicitId.toUpperCase();
        }
      }
    }

    if (!text) {
      continue;
    }
    if (!id || usedIds.has(id)) {
      do {
        id = "AC-" + nextNumber;
        nextNumber += 1;
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    criteria.push({ id, text, checked });
  }
  return criteria;
}

export interface AcceptanceCriteriaConversion {
  description: string;
  converted: number;
  changed: boolean;
}

/**
 * Explicit conversion of eligible plain bullets under Acceptance criteria /
 * Done when / equivalent headings into stable `- [ ] AC-n:` checklist lines.
 * Never runs implicitly — only through an approved plan.
 */
export function convertBulletsToAcceptanceCriteria(
  description: string | null | undefined,
): AcceptanceCriteriaConversion {
  const original = normalizeDescription(description);
  const lines = original.split(/\r?\n/);
  const sections = findAcceptanceSections(original);
  if (sections.length === 0) {
    return { description: original, converted: 0, changed: false };
  }
  const section = sections[0];
  const headingIndex = lines.findIndex((line) => line.trim() === section.heading);
  if (headingIndex < 0) {
    return { description: original, converted: 0, changed: false };
  }

  // Reserve only IDs already present as explicit checklist or AC-n bullets.
  // Plain bullets without an explicit ID must be free to receive AC-1, AC-2, …
  const usedIds = new Set<string>();
  for (const line of lines) {
    const checklist = line.match(criterionPattern);
    if (checklist?.[2]) {
      usedIds.add(checklist[2].toUpperCase());
      continue;
    }
    const plain = line.match(plainBulletPattern);
    if (plain) {
      const explicitId = /^(AC-\d+)\s*[:.)\-–—]/i.exec(plain[1].trim())?.[1];
      if (explicitId) {
        usedIds.add(explicitId.toUpperCase());
      }
    }
  }
  const emittedIds = new Set<string>();
  for (const line of lines) {
    const checklist = line.match(criterionPattern);
    if (checklist?.[2]) {
      emittedIds.add(checklist[2].toUpperCase());
    }
  }
  let nextNumber = 1;
  const allocateId = (): string => {
    let id: string;
    do {
      id = "AC-" + nextNumber;
      nextNumber += 1;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  const end = headingIndex + 1 + section.lines.length;
  let converted = 0;
  for (let index = headingIndex + 1; index < end; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    if (line.match(criterionPattern)) {
      continue;
    }
    const plain = line.match(plainBulletPattern);
    if (!plain) {
      continue;
    }
    const rest = plain[1].trim();
    const explicit = /^(AC-\d+)\s*[:.)\-–—]\s*(.+)$/i.exec(rest);
    if (explicit) {
      const requestedId = explicit[1].toUpperCase();
      const id = emittedIds.has(requestedId) ? allocateId() : requestedId;
      emittedIds.add(id);
      usedIds.add(id);
      lines[index] = "- [ ] " + id + ": " + explicit[2].trim();
      converted += 1;
      continue;
    }
    const id = allocateId();
    lines[index] = "- [ ] " + id + ": " + rest;
    converted += 1;
  }

  if (converted === 0) {
    return { description: original, converted: 0, changed: false };
  }
  return { description: lines.join("\n"), converted, changed: true };
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

export type PipelinePolicy = "enabled" | "disabled";

export interface EvaluateCriteriaOptions {
  /**
   * Project pipeline policy. `disabled` skips the pipeline gate entirely.
   * `enabled` (default) requires success when pipeline evidence exists, but
   * missing evidence without a local `.gitlab-ci.yml` is a warning, not a
   * permanent completion block.
   */
  pipelinePolicy?: PipelinePolicy;
  /** Whether a CI config is known to be present in the repository. */
  ciConfigPresent?: boolean;
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
  options: EvaluateCriteriaOptions = {},
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

  const pipelinePolicy = options.pipelinePolicy ?? "enabled";
  const normalizedPipelineStatus = pipelineStatus?.toLowerCase() ?? null;
  let pipelineSatisfied: boolean;
  if (pipelinePolicy === "disabled") {
    pipelineSatisfied = true;
  } else if (normalizedPipelineStatus === "success") {
    pipelineSatisfied = true;
  } else if (normalizedPipelineStatus === null && options.ciConfigPresent === false) {
    // Absent CI config + no pipeline evidence: unknown/warning, not a block.
    pipelineSatisfied = true;
    reasons.push(
      "pipeline evidence is unknown (no .gitlab-ci.yml and no pipeline found); treated as a warning under enabled policy",
    );
  } else {
    pipelineSatisfied = false;
    reasons.push(
      "latest pipeline is " + (pipelineStatus ?? "unknown") + "; expected success",
    );
  }

  return {
    passed: criteria.length > 0 && checks.every((check) => check.verified) && pipelineSatisfied,
    pipelineStatus: pipelineStatus ?? null,
    checks,
    reasons,
  };
}

export interface CriterionStateChange {
  description: string;
  id: string;
  checked: boolean;
  changed: boolean;
}

/**
 * Counts checklist items the way GitLab does when it derives
 * `task_completion_status`: every `- [ ]` / `- [x]` bullet anywhere in the
 * description, not just those under the acceptance-criteria heading. Counting
 * only the acceptance section would put a number in the audit note that
 * contradicts the count GitLab itself reports.
 */
export function countChecklistItems(
  description: string | null | undefined,
): { completed: number; total: number } {
  const text = normalizeDescription(description);
  let total = 0;
  let completed = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(criterionPattern);
    if (!match) {
      continue;
    }
    total += 1;
    if (match[1].toLowerCase() === "x") {
      completed += 1;
    }
  }
  return { completed, total };
}

/**
 * Flip the checkbox on one acceptance criterion, addressed either by its
 * explicit `AC-n` id or by its 1-based position among the criteria GitLab
 * parses. GitLab derives `task_completion_status` from these brackets, so
 * writing the description is the only way to change completion.
 *
 * Only the bracket is rewritten; indentation, bullet glyph, id, and trailing
 * text are preserved byte for byte. Never runs implicitly.
 */
export function setCriterionChecked(
  description: string | null | undefined,
  reference: string,
  checked: boolean,
): CriterionStateChange {
  const original = normalizeDescription(description);
  const criteria = parseAcceptanceCriteria(original);
  if (criteria.length === 0) {
    throw new Error(
      "No acceptance criteria found to update. Use --description to add a checklist first.",
    );
  }

  const wanted = reference.trim();
  const byId = criteria.filter((item) => item.id === wanted.toUpperCase());
  const byPosition = /^\d+$/.test(wanted) ? [criteria[Number(wanted) - 1]] : [];
  const matches = byId.length > 0 ? byId : byPosition;
  if (matches.length === 0) {
    throw new Error(
      "No acceptance criterion " + JSON.stringify(wanted) + " found. Available: " +
        criteria.map((item) => item.id).join(", ") + ".",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      "Acceptance criterion " + JSON.stringify(wanted) + " is ambiguous; address it by its explicit id.",
    );
  }
  const target = matches[0];
  if (target && target.checked === checked) {
    return { description: original, id: target.id, checked, changed: false };
  }

  const lines = original.split(/\r?\n/);
  const section = findAcceptanceSections(original)[0];
  const headingIndex = section
    ? lines.findIndex((line) => line.trim() === section.heading)
    : -1;
  if (headingIndex < 0) {
    return { description: original, id: target.id, checked, changed: false };
  }
  // Walk only the acceptance section, so a positional reference cannot tick a
  // checklist that lives under some other heading (`## Tasks`, for example).
  const end = headingIndex + 1 + (section?.lines.length ?? 0);
  let seen = 0;
  for (let index = headingIndex + 1; index < end; index += 1) {
    const line = lines[index];
    const match = line?.match(criterionPattern);
    if (!match) {
      continue;
    }
    const id = match[2]?.toUpperCase();
    if (id !== undefined) {
      if (id !== target.id) {
        continue;
      }
    } else {
      // Unlabelled bullet: the parser assigns ids by allocation order, so the
      // nth such bullet is the nth criterion. Count only within this section.
      seen += 1;
      if (seen !== Number(wanted)) {
        continue;
      }
    }
    const next = line.replace(criterionPattern, (whole) =>
      whole.replace(/\[([ xX])\]/, checked ? "[x]" : "[ ]"));
    if (next !== line) {
      lines[index] = next;
      return { description: lines.join("\n"), id: target.id, checked, changed: true };
    }
  }
  return { description: original, id: target.id, checked, changed: false };
}

function isPlaceholderEvidence(value: string): boolean {
  return /^(?:tbd|todo|none|n\/?a|pending|not available|-)$/i.test(value) ||
    /^(?:tbd|todo)\b/i.test(value);
}

function normalizeDescription(description: string | null | undefined): string {
  return (description ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
}

function isAcceptanceHeading(line: string): boolean {
  return /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?acceptance criteria\s*:?(?:\*\*|__)?\s*$/i.test(line);
}

function isDoneWhenHeading(line: string): boolean {
  return /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?done when\s*:?(?:\*\*|__)?\s*$/i.test(line);
}

function isEquivalentBulletHeading(line: string): boolean {
  return /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:definition of done|success criteria|exit criteria)\s*:?(?:\*\*|__)?\s*$/i.test(line);
}

function isSectionHeading(line: string): boolean {
  return /^\s*#{1,6}\s+/.test(line) ||
    /^\s*(?:\*\*|__)[^\r\n]+(?:\*\*|__)\s*:?[ \t]*$/.test(line);
}
