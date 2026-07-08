/**
 * Verdict model and the mapping from nexusmods.com file/mod status to a
 * verdict. Pure module: no vortex-api imports, unit-testable outside Vortex.
 *
 * Policy (agreed 2026-07-08):
 * - file category REMOVED, or mod status removed/wastebinned -> FLAGGED
 * - mod status under_moderation -> CAUTION (under review, no verdict yet)
 * - mod status hidden / not_published -> ignored (treated as available)
 * - no identity / no match on the site -> UNKNOWN
 * - lookup failure -> ERROR (never presented as safe)
 */

export type VerdictState = 'CLEAN' | 'FLAGGED' | 'CAUTION' | 'UNKNOWN' | 'ERROR';

export interface Verdict {
  state: VerdictState;
  reason: string;
}

/** ModFileCategory value that marks a file deleted on the site. */
const FILE_CATEGORY_REMOVED = 'REMOVED';

/** Mod statuses that mean the mod was taken down. */
const MOD_STATUS_FLAGGED = ['removed', 'wastebinned'];

/** Mod statuses that mean "being reviewed - caution, but no verdict yet". */
const MOD_STATUS_CAUTION = ['under_moderation'];

/** Severity order used when combining verdicts (higher index wins). */
const STATE_ORDER: VerdictState[] = ['CLEAN', 'UNKNOWN', 'ERROR', 'CAUTION', 'FLAGGED'];

export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  return STATE_ORDER.indexOf(b.state) > STATE_ORDER.indexOf(a.state) ? b : a;
}

export function verdictForModStatus(modStatus: string | undefined): Verdict {
  if (modStatus === undefined) {
    return {
      state: 'FLAGGED',
      reason: 'mod no longer exists on Nexus Mods (it may have been deleted)',
    };
  }
  if (MOD_STATUS_FLAGGED.includes(modStatus)) {
    return { state: 'FLAGGED', reason: 'mod was removed from Nexus Mods' };
  }
  if (MOD_STATUS_CAUTION.includes(modStatus)) {
    return {
      state: 'CAUTION',
      reason: 'mod is under review by Nexus Mods moderation - no verdict yet',
    };
  }
  // published, hidden, not_published, publish_with_game: no adverse action
  return { state: 'CLEAN', reason: 'available on Nexus Mods' };
}

export function verdictForFileCategory(fileCategory: string | undefined): Verdict {
  if (fileCategory === undefined) {
    return { state: 'UNKNOWN', reason: 'file is not listed on the mod page' };
  }
  if (fileCategory === FILE_CATEGORY_REMOVED) {
    return { state: 'FLAGGED', reason: 'file was deleted on Nexus Mods' };
  }
  // MAIN, UPDATE, OPTIONAL, OLD_VERSION, MISCELLANEOUS, ARCHIVED are all benign
  return { state: 'CLEAN', reason: 'file is available on Nexus Mods' };
}

/**
 * Combined verdict for a file we resolved on the site: the worse of the
 * file-level and mod-level signal wins.
 */
export function verdictForNexusFile(
  fileCategory: string | undefined,
  modStatus: string | undefined,
): Verdict {
  return worstVerdict(verdictForFileCategory(fileCategory), verdictForModStatus(modStatus));
}

export const VERDICT_UNKNOWN_NO_IDENTITY: Verdict = {
  state: 'UNKNOWN',
  reason: 'not a Nexus Mods download and no hash match - provenance unknown',
};

export const VERDICT_UNKNOWN_NO_HASH_MATCH: Verdict = {
  state: 'UNKNOWN',
  reason: 'archive hash not known to Nexus Mods',
};

export function verdictError(detail: string): Verdict {
  return { state: 'ERROR', reason: `could not verify: ${detail}` };
}

/**
 * How a verdict is presented in Vortex's health check UI.
 * Values match Vortex's IHealthCheckResult status / HealthCheckSeverity
 * string enums; the wiring layer casts them.
 */
export interface HealthPresentation {
  status: 'passed' | 'failed' | 'warning' | 'error';
  severity: 'info' | 'warning' | 'error' | 'critical';
}

/** Short label for table columns and summaries. */
export function verdictLabel(state: VerdictState | undefined): string {
  switch (state) {
    case 'CLEAN':
      return 'Clean';
    case 'FLAGGED':
      return 'FLAGGED';
    case 'CAUTION':
      return 'Caution';
    case 'UNKNOWN':
      return 'Unknown';
    case 'ERROR':
      return 'Check failed';
    default:
      return 'Not checked';
  }
}

export function presentVerdict(verdict: Verdict): HealthPresentation {
  switch (verdict.state) {
    case 'FLAGGED':
      return { status: 'failed', severity: 'critical' };
    case 'CAUTION':
      return { status: 'warning', severity: 'warning' };
    case 'ERROR':
      // visible and never green, but not an alarm
      return { status: 'error', severity: 'warning' };
    case 'UNKNOWN':
      return { status: 'warning', severity: 'info' };
    case 'CLEAN':
      return { status: 'passed', severity: 'info' };
  }
}
