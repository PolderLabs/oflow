/**
 * Whether the English checkpoint can be expected to read a given text.
 *
 * This is a precondition check, not a classifier, and it is the one Laya
 * capability that survived scrutiny on a different axis from the rest. The
 * triage question was measured and rejected because it cannot separate
 * construction from verification work on story-shaped English text. This asks
 * something else entirely -- is the input something the English checkpoint can
 * read at all -- and on that it behaves.
 *
 * Measured here:
 *
 * | input | `is_english` | script |
 * |---|---|---|
 * | English story text | true | latin |
 * | German, Japanese, Hindi, Korean, Chinese, Russian, Arabic | **false** | latin / kana |
 * | French, Portuguese, Dutch | true -- **not** filtered | latin |
 * | code, acronym soup | true | latin |
 * | emoji only, digits only, whitespace | **true** | -- |
 *
 * Two limits worth stating. It detects natural language rather than
 * checkpoint reachability, so code and acronyms pass -- which is correct for
 * oflow, since work items are prose, but is not a general safety check. And
 * `detect_language` returns `None` for most short strings while `is_english`
 * returns true for them, so the two disagree on exactly the short items a
 * board is made of; use `is_english`, not `detect_language`.
 *
 * If this is ever used to gate the triage paths, note that the question still
 * degrades on non-English input: a matched construction/verification pair
 * separates by +0.57 in English and +0.33 in German. A readability gate makes
 * the signal weaker, never wrong-signed.
 */

/** Result of a readability probe, with the reason a caller might care about. */
export interface Readability {
  /** True when the English checkpoint can be expected to read the text. */
  readable: boolean;
  /**
   * Dominant script, as reported by the engine -- `latin`, `han`, `kana`,
   * `devanagari`, and so on, or `unknown` when there are no letters. Null when
   * the probe did not run.
   */
  script: string | null;
}

/** One reading from a caller-supplied probe. */
export interface ReadabilityProbeResult {
  /** The engine's verdict, or null when it could not decide. */
  readable: boolean | null;
  /** Dominant script, or null when the engine did not report one. */
  script?: string | null;
}

/**
 * Read the text back through a caller-supplied probe, or `null` if
 * unavailable.
 *
 * The probe is injected rather than shelling out so this stays portable and
 * testable: it has no dependency on where laya is installed, and the tests
 * need no Python at all.
 *
 * There is deliberately no question set here. The engine exposes `is_english`
 * and `detect_script` as direct functions, and a first version described an
 * equivalent `noul` question that was never actually used. Shipping an unused
 * question alongside the real path would leave two ways to do one thing, with
 * only one of them calibrated.
 */
export async function readTextReadability(
  text: string,
  probe: (texts: readonly string[]) => Promise<(ReadabilityProbeResult | null)[] | null>,
): Promise<Readability | null> {
  const trimmed = text.trim();
  // Nothing to read is not a readability problem; calling it unreadable would
  // report a blank field as a language failure.
  if (trimmed === "") return { readable: true, script: null };
  let answers: (ReadabilityProbeResult | null)[] | null;
  try {
    answers = await probe([trimmed]);
  } catch {
    // A crashed or timed-out engine is the same class of outcome as one that
    // never ran: no reading. Letting the rejection escape would make a
    // precondition check able to break the command it was meant to inform.
    return null;
  }
  if (answers === null) return null;
  const value = answers[0];
  // A probe that returns something other than our shape is a wiring mistake,
  // not "no reading". Treating it as unreadable would fire the gate on every
  // story, and treating it as silence is what hid the original bug: a bare
  // function reference resolves its interpreter from PATH instead of
  // OFLOW_LAYA_PYTHON, fails, and the gate quietly never ran. Distinguishing
  // the two makes that impossible to miss.
  // A null answer means the engine could not decide, which is not the same as
  // unreadable, and must not be reported as unreadable.
  if (value === null || value === undefined) return null;
  // A probe returning the wrong shape is a wiring error, not a finding.
  if (typeof value !== "object") {
    throw new TypeError(
      "readability probe must return { readable, script? } entries; got " + typeof value,
    );
  }
  if (typeof value.readable !== "boolean") return null;
  return {
    readable: value.readable,
    // Report the engine's own script. It is genuinely informative -- Japanese
    // reads as `kana` where German reads as `latin` -- so an unreadable result
    // can say why rather than only that.
    script: typeof value.script === "string" ? value.script : null,
  };
}
