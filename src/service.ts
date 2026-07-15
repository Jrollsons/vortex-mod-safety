/**
 * VerdictService: bridges Vortex state to the pure safety modules.
 * Gathers identities from Redux state, runs ONE batched provider scan per
 * mods-set (deduping the parallel per-mod checkMod calls), and caches
 * results.
 */

import { actions, log, selectors, types, util } from 'vortex-api';

import { extractIdentity, ModIdentity } from './safety/identity';
import type { VerdictProvider } from './safety/provider';
import { Verdict, verdictError } from './safety/verdict';

/** Successful scans are reused for this long. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Failed scans are retried sooner. */
const ERROR_TTL_MS = 30 * 1000;

export interface ScanResult {
  verdicts: Map<string, Verdict>;
  signature: string;
  timestamp: number;
  failed: boolean;
}

/**
 * Called after every ACTUAL scan (cached results do not re-fire it), for
 * both successful and failed scans. Used to surface scan results to the
 * user regardless of which trigger (health check, startup, manual button,
 * mod install) caused the scan.
 */
export type ScanCallback = (api: types.IExtensionApi, scan: ScanResult) => void;

export class VerdictService {
  private last?: ScanResult;
  private inflight?: Promise<ScanResult>;

  constructor(
    private provider: VerdictProvider,
    private onScan?: ScanCallback,
  ) {}

  /**
   * Verdict for a single installed mod of the active game. Triggers (or
   * joins) a batched scan of all installed mods.
   */
  public async getVerdict(api: types.IExtensionApi, vortexModId: string): Promise<Verdict> {
    const scan = await this.ensureScan(api);
    return (
      scan.verdicts.get(vortexModId) ??
      verdictError('mod was not part of the last scan (it may have just been installed)')
    );
  }

  /** Scan all installed mods of the active game, reusing a fresh cache. */
  public async scanAll(api: types.IExtensionApi, force = false): Promise<Map<string, Verdict>> {
    const scan = await this.ensureScan(api, force);
    return scan.verdicts;
  }

  private gatherIdentities(api: types.IExtensionApi): ModIdentity[] {
    const state = api.getState();
    const gameId = selectors.activeGameId(state);
    if (gameId === undefined) {
      return [];
    }
    // for most games the nexus domain equals the internal game id; game
    // extensions that differ carry the domain in details.nexusPageId, and
    // Nexus-sourced mods carry the authoritative domain in downloadGame
    const game = selectors.gameById(state, gameId);
    const fallbackDomain: string = game?.details?.nexusPageId ?? gameId;
    const mods = state.persistent.mods[gameId] ?? {};
    return Object.values(mods).map((mod: types.IMod) =>
      extractIdentity(mod.id, mod.attributes ?? {}, mod.type, fallbackDomain),
    );
  }

  private ensureScan(api: types.IExtensionApi, force = false): Promise<ScanResult> {
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    const identities = this.gatherIdentities(api);
    const signature = identities
      .map((id) => `${id.key}|${id.fileMD5 ?? ''}|${id.nexusFileId ?? ''}`)
      .sort()
      .join(';');

    if (!force && this.last !== undefined && this.last.signature === signature) {
      const ttl = this.last.failed ? ERROR_TTL_MS : CACHE_TTL_MS;
      if (Date.now() - this.last.timestamp < ttl) {
        return Promise.resolve(this.last);
      }
    }

    this.inflight = this.runScan(api, identities, signature).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Write verdicts into mod attributes so the Safety column on the mods
   * table updates reactively (and persists). Only dispatches actual changes.
   * The scan signature ignores these attributes, so this cannot re-trigger
   * a scan.
   */
  private publishAttributes(api: types.IExtensionApi, verdicts: Map<string, Verdict>): void {
    const state = api.getState();
    const gameId = selectors.activeGameId(state);
    if (gameId === undefined) {
      return;
    }
    const mods = state.persistent.mods[gameId] ?? {};
    const dispatchQueue: any[] = [];
    verdicts.forEach((verdict, modId) => {
      const attrs = mods[modId]?.attributes;
      if (attrs === undefined) {
        return;
      }
      if (
        attrs['safetyVerdict'] !== verdict.state ||
        attrs['safetyVerdictReason'] !== verdict.reason
      ) {
        dispatchQueue.push(
          actions.setModAttributes(gameId, modId, {
            safetyVerdict: verdict.state,
            safetyVerdictReason: verdict.reason,
          }),
        );
      }
    });
    if (dispatchQueue.length > 0) {
      util.batchDispatch(api.store, dispatchQueue);
    }
  }

  private async runScan(
    api: types.IExtensionApi,
    identities: ModIdentity[],
    signature: string,
  ): Promise<ScanResult> {
    const started = Date.now();
    try {
      const verdicts = await this.provider.getVerdicts(identities);
      log('info', 'mod-safety: scan complete', {
        mods: identities.length,
        elapsedMS: Date.now() - started,
        flagged: countState(verdicts, 'FLAGGED'),
        caution: countState(verdicts, 'CAUTION'),
        unknown: countState(verdicts, 'UNKNOWN'),
      });
      for (const id of identities) {
        const verdict = verdicts.get(id.key);
        if (verdict !== undefined && verdict.state !== 'CLEAN') {
          log('info', 'mod-safety: verdict', {
            mod: id.name,
            state: verdict.state,
            reason: verdict.reason,
            domain: id.gameDomain,
            modId: id.nexusModId,
            fileId: id.nexusFileId,
          });
        }
      }
      this.last = { verdicts, signature, timestamp: Date.now(), failed: false };
      this.publishAttributes(api, verdicts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', 'mod-safety: scan failed', { error: message });
      const verdicts = new Map<string, Verdict>();
      for (const id of identities) {
        verdicts.set(id.key, verdictError(message));
      }
      this.last = { verdicts, signature, timestamp: Date.now(), failed: true };
    }
    try {
      this.onScan?.(api, this.last);
    } catch (err) {
      log('warn', 'mod-safety: scan callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.last;
  }
}

function countState(verdicts: Map<string, Verdict>, state: Verdict['state']): number {
  let count = 0;
  verdicts.forEach((verdict) => {
    if (verdict.state === state) {
      count++;
    }
  });
  return count;
}
