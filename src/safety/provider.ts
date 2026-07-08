/**
 * VerdictProvider abstraction plus a mock implementation for tests and
 * offline development. Pure module: no vortex-api imports.
 */

import type { ModIdentity } from './identity';
import type { Verdict } from './verdict';
import { VERDICT_UNKNOWN_NO_IDENTITY } from './verdict';

export interface VerdictProvider {
  /**
   * Look up verdicts for a batch of mods. Returns a map keyed by
   * ModIdentity.key with an entry for every input.
   * Implementations should THROW on transport failure (network/HTTP/GraphQL
   * errors); the caller maps that to ERROR for the whole batch. A missing
   * match is not an error - it maps to UNKNOWN/FLAGGED per policy.
   */
  getVerdicts(mods: ModIdentity[]): Promise<Map<string, Verdict>>;
}

/**
 * Mock provider: canned verdicts keyed by Vortex mod id, with optional
 * rules for everything else. A mod whose name contains "FLAGME" is flagged,
 * so install-time behavior can be exercised without touching the network.
 */
export class MockVerdictProvider implements VerdictProvider {
  constructor(
    private canned: Record<string, Verdict> = {},
    private fallback: Verdict = VERDICT_UNKNOWN_NO_IDENTITY,
  ) {}

  public async getVerdicts(mods: ModIdentity[]): Promise<Map<string, Verdict>> {
    const result = new Map<string, Verdict>();
    for (const mod of mods) {
      if (this.canned[mod.key] !== undefined) {
        result.set(mod.key, this.canned[mod.key]);
      } else if (mod.name.toUpperCase().includes('FLAGME')) {
        result.set(mod.key, { state: 'FLAGGED', reason: 'mock: name contains FLAGME' });
      } else {
        result.set(mod.key, this.fallback);
      }
    }
    return result;
  }
}
