/**
 * VerdictProvider backed by the nexusmods.com GraphQL v2 API.
 * Pure module: no vortex-api imports; fetch is injectable for tests.
 *
 * Lookups are batched POST requests - hashes and ids only ever travel in the
 * request body, never in a URL.
 *
 * Query shapes verified live against api.nexusmods.com/v2/graphql
 * (2026-07-08):
 * - fileHashes(md5s: [String!]!): [FileHash]           (batch MD5 lookup)
 * - legacyModsByDomain(ids: [{gameDomain, modId}], count, offset): ModPage
 *   (returns removed mods with status "removed"; hard-deleted mods are
 *    absent from the result; nodes are NOT in request order; the server
 *    CAPS each page at 80 nodes no matter what count asks for, so results
 *    must be collected via offset pagination until totalCount is reached)
 * - modFiles(gameId: ID!, modId: ID!): [ModFile]       (file categories;
 *   deleted files still listed with category REMOVED)
 */

import type { ModIdentity } from './identity';
import { hasNexusIdentity } from './identity';
import type { VerdictProvider } from './provider';
import type { Verdict } from './verdict';
import {
  VERDICT_UNKNOWN_NO_HASH_MATCH,
  VERDICT_UNKNOWN_NO_IDENTITY,
  verdictForFileCategory,
  verdictForModStatus,
  verdictForNexusFile,
  worstVerdict,
} from './verdict';

export const NEXUS_GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';

/** Max ids per batched status request (results are offset-paginated). */
const CHUNK_SIZE = 50;
/**
 * Batch size and rounds for re-verifying mods that were missing from a
 * status response. The live API sometimes randomly drops rows from large
 * batches (observed 2026-07-08: different mods missing on consecutive
 * identical scans, each verified fine individually), so absence from a
 * single batch must NEVER be treated as "deleted from the site".
 */
const VERIFY_CHUNK_SIZE = 10;
const VERIFY_ROUNDS = 2;
/**
 * Max md5s per fileHashes request. fileHashes returns a plain list with no
 * pagination, and one md5 can match many rows - keep requests small so a
 * server-side result cap can't silently truncate matches.
 */
const MD5_CHUNK_SIZE = 25;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<FetchResponseLike>;

interface HashRow {
  md5: string;
  fileSize?: number;
  gameId?: number;
  fileName?: string;
  modFile?: {
    fileId: number;
    category: string;
    mod?: { modId: number; status: string };
  };
}

interface ModStatusRow {
  modId: number;
  gameId: number;
  status: string;
}

interface ModFileRow {
  fileId: number;
  category: string;
}

export class NexusVerdictProvider implements VerdictProvider {
  constructor(
    private fetchFn: FetchLike = (globalThis as any).fetch?.bind(globalThis),
    private endpoint: string = NEXUS_GRAPHQL_URL,
  ) {
    if (this.fetchFn === undefined) {
      throw new Error('no fetch implementation available');
    }
  }

  public async getVerdicts(mods: ModIdentity[]): Promise<Map<string, Verdict>> {
    const result = new Map<string, Verdict>();

    const toCheck = mods.filter((mod) => {
      if (mod.isCollection) {
        result.set(mod.key, { state: 'CLEAN', reason: 'collection (curated by Nexus Mods)' });
        return false;
      }
      if (!hasNexusIdentity(mod) && mod.fileMD5 === undefined) {
        result.set(mod.key, VERDICT_UNKNOWN_NO_IDENTITY);
        return false;
      }
      return true;
    });

    if (toCheck.length === 0) {
      return result;
    }

    // Round 1: batch MD5 lookups + mod statuses per game domain.
    const md5s = unique(toCheck.map((mod) => mod.fileMD5).filter(isDefined));
    const identified = toCheck.filter(hasNexusIdentity);
    const idsByDomain = new Map<string, number[]>();
    for (const mod of identified) {
      const list = idsByDomain.get(mod.gameDomain) ?? [];
      if (!list.includes(mod.nexusModId)) {
        list.push(mod.nexusModId);
      }
      idsByDomain.set(mod.gameDomain, list);
    }

    const hashRows = await this.queryFileHashes(md5s);
    const statusByDomainMod = await this.queryModStatuses(idsByDomain);
    await this.verifyMissingStatuses(idsByDomain, statusByDomainMod);

    const hashRowsByMD5 = new Map<string, HashRow[]>();
    for (const row of hashRows) {
      const key = row.md5.toLowerCase();
      hashRowsByMD5.set(key, (hashRowsByMD5.get(key) ?? []).concat(row));
    }

    // Round 2: file categories for identified mods whose file the MD5 rows
    // did not resolve.
    const needFiles = identified.filter(
      (mod) =>
        mod.nexusFileId !== undefined &&
        matchHashRowToIdentity(hashRowsByMD5.get(mod.fileMD5 ?? '') ?? [], mod) === undefined,
    );
    const filesByDomainMod = await this.queryModFiles(needFiles, statusByDomainMod);

    for (const mod of toCheck) {
      result.set(
        mod.key,
        resolveVerdict(mod, hashRowsByMD5, statusByDomainMod, filesByDomainMod),
      );
    }
    return result;
  }

  private async post(query: string): Promise<any> {
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      throw new Error(`Nexus Mods API returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.errors !== undefined && payload.errors.length > 0) {
      throw new Error(`Nexus Mods API error: ${payload.errors[0]?.message ?? 'unknown'}`);
    }
    if (payload.data === undefined) {
      throw new Error('Nexus Mods API returned no data');
    }
    return payload.data;
  }

  private async queryFileHashes(md5s: string[]): Promise<HashRow[]> {
    const rows: HashRow[] = [];
    for (const chunk of chunks(md5s, MD5_CHUNK_SIZE)) {
      const query = `{ fileHashes(md5s: ${JSON.stringify(chunk)}) {
        md5 fileSize gameId fileName
        modFile { fileId category mod { modId status } }
      } }`;
      const data = await this.post(query);
      for (const row of data.fileHashes ?? []) {
        if (row !== null) {
          rows.push({ ...row, fileSize: toNumber(row.fileSize) });
        }
      }
    }
    return rows;
  }

  private async queryModStatuses(
    idsByDomain: Map<string, number[]>,
  ): Promise<Map<string, ModStatusRow>> {
    const result = new Map<string, ModStatusRow>();
    for (const [domain, modIds] of idsByDomain) {
      for (const chunk of chunks(modIds, CHUNK_SIZE)) {
        await this.fetchStatusChunk(domain, chunk, result);
      }
    }
    return result;
  }

  private async fetchStatusChunk(
    domain: string,
    modIds: number[],
    result: Map<string, ModStatusRow>,
  ): Promise<void> {
    const ids = modIds
      .map((modId) => `{gameDomain: ${JSON.stringify(domain)}, modId: ${modId}}`)
      .join(', ');
    // the server caps pages at 80 nodes regardless of `count`; page via
    // offset until we have totalCount nodes or a page comes back empty
    let offset = 0;
    let expected = modIds.length;
    while (offset < expected) {
      const query = `{ legacyModsByDomain(ids: [${ids}], count: ${modIds.length}, offset: ${offset}) {
        nodes { modId gameId status }
        totalCount
      } }`;
      const data = await this.post(query);
      const nodes = data.legacyModsByDomain?.nodes ?? [];
      expected = Math.min(data.legacyModsByDomain?.totalCount ?? 0, modIds.length);
      for (const node of nodes) {
        result.set(`${domain}:${node.modId}`, node);
      }
      if (nodes.length === 0) {
        break;
      }
      offset += nodes.length;
    }
  }

  /**
   * Mods missing from a batch status response are re-queried in small
   * batches before we conclude they are gone from the site. Absence after
   * all rounds is the actual "deleted" signal.
   */
  private async verifyMissingStatuses(
    idsByDomain: Map<string, number[]>,
    statusByDomainMod: Map<string, ModStatusRow>,
  ): Promise<void> {
    for (let round = 0; round < VERIFY_ROUNDS; round++) {
      const missingByDomain = new Map<string, number[]>();
      for (const [domain, modIds] of idsByDomain) {
        const missing = modIds.filter(
          (modId) => !statusByDomainMod.has(`${domain}:${modId}`),
        );
        if (missing.length > 0) {
          missingByDomain.set(domain, missing);
        }
      }
      if (missingByDomain.size === 0) {
        return;
      }
      for (const [domain, missing] of missingByDomain) {
        for (const chunk of chunks(missing, VERIFY_CHUNK_SIZE)) {
          await this.fetchStatusChunk(domain, chunk, statusByDomainMod);
        }
      }
    }
  }

  private async queryModFiles(
    mods: Array<ModIdentity & { gameDomain: string; nexusModId: number }>,
    statusByDomainMod: Map<string, ModStatusRow>,
  ): Promise<Map<string, ModFileRow[]>> {
    const result = new Map<string, ModFileRow[]>();

    // modFiles() needs the numeric game id; take it from any status row of
    // the same domain. Mods whose status row is absent are FLAGGED by the
    // mod-level verdict anyway, so skipping their file lookup is fine.
    const targets: Array<{ domainMod: string; gameId: number; modId: number }> = [];
    const seen = new Set<string>();
    for (const mod of mods) {
      const domainMod = `${mod.gameDomain}:${mod.nexusModId}`;
      const statusRow = statusByDomainMod.get(domainMod);
      if (statusRow !== undefined && !seen.has(domainMod)) {
        seen.add(domainMod);
        targets.push({ domainMod, gameId: statusRow.gameId, modId: mod.nexusModId });
      }
    }

    for (const chunk of chunks(targets, 25)) {
      const aliases = chunk
        .map(
          (t, idx) =>
            `f${idx}: modFiles(gameId: "${t.gameId}", modId: "${t.modId}") { fileId category }`,
        )
        .join('\n');
      const data = await this.post(`{ ${aliases} }`);
      chunk.forEach((t, idx) => {
        result.set(t.domainMod, data[`f${idx}`] ?? []);
      });
    }
    return result;
  }
}

function resolveVerdict(
  mod: ModIdentity,
  hashRowsByMD5: Map<string, HashRow[]>,
  statusByDomainMod: Map<string, ModStatusRow>,
  filesByDomainMod: Map<string, ModFileRow[]>,
): Verdict {
  const hashRows = mod.fileMD5 !== undefined ? (hashRowsByMD5.get(mod.fileMD5) ?? []) : [];

  if (hasNexusIdentity(mod)) {
    const domainMod = `${mod.gameDomain}:${mod.nexusModId}`;
    const modVerdict = verdictForModStatus(statusByDomainMod.get(domainMod)?.status);

    let fileVerdict: Verdict | undefined;
    const hashMatch = matchHashRowToIdentity(hashRows, mod);
    if (hashMatch?.modFile !== undefined) {
      fileVerdict = verdictForNexusFile(hashMatch.modFile.category, hashMatch.modFile.mod?.status);
    } else if (mod.nexusFileId !== undefined) {
      const files = filesByDomainMod.get(domainMod);
      if (files !== undefined) {
        const file = files.find((row) => row.fileId === mod.nexusFileId);
        fileVerdict = verdictForFileCategory(file?.category);
      }
    }
    return fileVerdict !== undefined ? worstVerdict(modVerdict, fileVerdict) : modVerdict;
  }

  // Hash-only (manually added archive that Vortex hashed).
  if (hashRows.length === 0) {
    return VERDICT_UNKNOWN_NO_HASH_MATCH;
  }
  const candidates =
    mod.fileSize !== undefined && hashRows.some((row) => row.fileSize === mod.fileSize)
      ? hashRows.filter((row) => row.fileSize === mod.fileSize)
      : hashRows;
  const verdicts = candidates
    .filter((row) => row.modFile !== undefined)
    .map((row) => verdictForNexusFile(row.modFile!.category, row.modFile!.mod?.status));
  if (verdicts.length === 0) {
    return VERDICT_UNKNOWN_NO_HASH_MATCH;
  }
  if (verdicts.every((verdict) => verdict.state === verdicts[0].state)) {
    return verdicts[0];
  }
  return {
    state: 'UNKNOWN',
    reason: 'archive hash matches multiple Nexus Mods files with differing status',
  };
}

function matchHashRowToIdentity(
  rows: HashRow[],
  mod: ModIdentity & { nexusModId: number },
): HashRow | undefined {
  const sameMod = rows.filter((row) => row.modFile?.mod?.modId === mod.nexusModId);
  if (mod.nexusFileId !== undefined) {
    const exact = sameMod.find((row) => row.modFile?.fileId === mod.nexusFileId);
    if (exact !== undefined) {
      return exact;
    }
  }
  return sameMod.length === 1 ? sameMod[0] : undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function* chunks<T>(values: T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) {
    yield values.slice(i, i + size);
  }
}
