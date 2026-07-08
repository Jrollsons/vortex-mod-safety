import type { ModIdentity } from '../identity';
import { NexusVerdictProvider } from '../nexusProvider';

/**
 * Fake fetch that answers the provider's GraphQL queries from canned data.
 * Routes on query content, mirroring the live API shapes verified 2026-07-08.
 */
function makeFetch(handlers: {
  fileHashes?: (md5s: string[]) => any[];
  modStatuses?: (domain: string, requestedIds: number[], callIndex: number) => any[];
  modFiles?: (modId: string) => any[];
  failWith?: { status?: number; graphError?: string; network?: boolean };
}) {
  const calls: string[] = [];
  let statusCalls = 0;
  const fetchFn = async (_url: string, init: { body: string }) => {
    const query: string = JSON.parse(init.body).query;
    calls.push(query);
    if (handlers.failWith?.network) {
      throw new Error('ECONNRESET');
    }
    if (handlers.failWith?.status !== undefined) {
      return { ok: false, status: handlers.failWith.status, json: async () => ({}) };
    }
    if (handlers.failWith?.graphError !== undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: handlers.failWith!.graphError }] }),
      };
    }

    let data: any = {};
    if (query.includes('fileHashes')) {
      const md5s = JSON.parse(query.match(/md5s: (\[[^\]]*\])/)![1]);
      data = { fileHashes: handlers.fileHashes?.(md5s) ?? [] };
    } else if (query.includes('legacyModsByDomain')) {
      const domain = query.match(/gameDomain: "([^"]+)"/)![1];
      const offset = parseInt(query.match(/offset: (\d+)/)![1], 10);
      const requestedIds = [...query.matchAll(/modId: (\d+)/g)].map((m) => parseInt(m[1], 10));
      const all = (handlers.modStatuses?.(domain, requestedIds, statusCalls++) ?? []).filter(
        (row: any) => requestedIds.includes(row.modId),
      );
      // mirror the live API: pages are capped at 80 nodes regardless of count
      data = {
        legacyModsByDomain: { nodes: all.slice(offset, offset + 80), totalCount: all.length },
      };
    } else if (query.includes('modFiles')) {
      data = {};
      const aliasRe = /(f\d+): modFiles\(gameId: "\d+", modId: "(\d+)"\)/g;
      let match;
      while ((match = aliasRe.exec(query)) !== null) {
        data[match[1]] = handlers.modFiles?.(match[2]) ?? [];
      }
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetchFn, calls };
}

function nexusMod(overrides: Partial<ModIdentity> = {}): ModIdentity {
  return {
    key: 'vortex-mod-1',
    name: 'Test Mod',
    gameDomain: 'stardewvalley',
    nexusModId: 2400,
    nexusFileId: 9622,
    fileMD5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fileSize: 1000,
    isCollection: false,
    ...overrides,
  };
}

describe('NexusVerdictProvider', () => {
  it('CLEAN: md5 row matches identity, benign category, published mod', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: (md5s) => [
        {
          md5: md5s[0],
          fileSize: 1000,
          gameId: 1303,
          modFile: { fileId: 9622, category: 'OLD_VERSION', mod: { modId: 2400, status: 'published' } },
        },
      ],
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'published' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('CLEAN');
  });

  it('FLAGGED: file category REMOVED', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: (md5s) => [
        {
          md5: md5s[0],
          fileSize: 1000,
          modFile: { fileId: 9622, category: 'REMOVED', mod: { modId: 2400, status: 'published' } },
        },
      ],
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'published' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('FLAGGED');
    expect(verdicts.get('vortex-mod-1')!.reason).toContain('deleted');
  });

  it('FLAGGED: mod removed even when file row is benign', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: (md5s) => [
        {
          md5: md5s[0],
          fileSize: 1000,
          modFile: { fileId: 9622, category: 'MAIN', mod: { modId: 2400, status: 'removed' } },
        },
      ],
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'removed' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('FLAGGED');
  });

  it('FLAGGED: mod absent from legacyModsByDomain response (hard-deleted)', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: () => [],
      modStatuses: () => [], // no node returned
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('FLAGGED');
    expect(verdicts.get('vortex-mod-1')!.reason).toContain('no longer exists');
  });

  it('CAUTION: mod under moderation', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: (md5s) => [
        {
          md5: md5s[0],
          fileSize: 1000,
          modFile: { fileId: 9622, category: 'MAIN', mod: { modId: 2400, status: 'under_moderation' } },
        },
      ],
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'under_moderation' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('CAUTION');
  });

  it('CLEAN: hidden mod is ignored per policy', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: (md5s) => [
        {
          md5: md5s[0],
          fileSize: 1000,
          modFile: { fileId: 9622, category: 'MAIN', mod: { modId: 2400, status: 'hidden' } },
        },
      ],
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'hidden' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('CLEAN');
  });

  it('falls back to modFiles when the md5 rows do not match the identity', async () => {
    const { fetchFn, calls } = makeFetch({
      fileHashes: () => [], // no hash match at all
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'published' }],
      modFiles: () => [{ fileId: 9622, category: 'REMOVED' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('FLAGGED');
    expect(calls.some((query) => query.includes('modFiles('))).toBe(true);
  });

  it('UNKNOWN: identified mod published but file not listed on mod page', async () => {
    const { fetchFn } = makeFetch({
      fileHashes: () => [],
      modStatuses: () => [{ modId: 2400, gameId: 1303, status: 'published' }],
      modFiles: () => [{ fileId: 111, category: 'MAIN' }], // our fileId missing
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([nexusMod()]);
    expect(verdicts.get('vortex-mod-1')!.state).toBe('UNKNOWN');
  });

  it('hash-only mod: disambiguates md5 multi-match by fileSize', async () => {
    const manual = nexusMod({
      key: 'manual-1',
      gameDomain: undefined,
      nexusModId: undefined,
      nexusFileId: undefined,
      fileSize: 2000,
    });
    const { fetchFn } = makeFetch({
      fileHashes: (md5s) => [
        {
          md5: md5s[0],
          fileSize: 1000,
          modFile: { fileId: 1, category: 'MAIN', mod: { modId: 10, status: 'published' } },
        },
        {
          md5: md5s[0],
          fileSize: 2000,
          modFile: { fileId: 2, category: 'REMOVED', mod: { modId: 20, status: 'published' } },
        },
      ],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([manual]);
    expect(verdicts.get('manual-1')!.state).toBe('FLAGGED');
  });

  it('hash-only mod with no match: UNKNOWN', async () => {
    const manual = nexusMod({
      key: 'manual-1',
      gameDomain: undefined,
      nexusModId: undefined,
      nexusFileId: undefined,
    });
    const { fetchFn } = makeFetch({ fileHashes: () => [] });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([manual]);
    expect(verdicts.get('manual-1')!.state).toBe('UNKNOWN');
  });

  it('identity-less mod: UNKNOWN without any network call', async () => {
    const bare: ModIdentity = { key: 'bare', name: 'bare', isCollection: false };
    const { fetchFn, calls } = makeFetch({});
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([bare]);
    expect(verdicts.get('bare')!.state).toBe('UNKNOWN');
    expect(calls).toHaveLength(0);
  });

  it('collection: skipped as CLEAN without lookup', async () => {
    const coll = nexusMod({ key: 'coll', isCollection: true });
    const { fetchFn } = makeFetch({
      fileHashes: () => [],
      modStatuses: () => [],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts([coll]);
    expect(verdicts.get('coll')!.state).toBe('CLEAN');
  });

  it('paginates past the 80-node page cap instead of flagging the tail', async () => {
    // 95 published mods; a single un-paginated request would only see 80 of
    // them and wrongly flag the other 15 as "no longer exists"
    const mods = Array.from({ length: 95 }, (_, i) =>
      nexusMod({
        key: `mod-${i + 1}`,
        nexusModId: i + 1,
        nexusFileId: undefined,
        fileMD5: undefined,
      }),
    );
    const { fetchFn } = makeFetch({
      modStatuses: () =>
        Array.from({ length: 95 }, (_, i) => ({
          modId: i + 1,
          gameId: 1303,
          status: 'published',
        })),
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts(mods);
    const flagged = [...verdicts.values()].filter((verdict) => verdict.state === 'FLAGGED');
    expect(flagged).toHaveLength(0);
    expect(verdicts.get('mod-95')!.state).toBe('CLEAN');
  });

  it('re-verifies mods randomly dropped from a batch instead of flagging them', async () => {
    // live API behavior observed 2026-07-08: large batches randomly omit
    // rows that exist; only absence confirmed by targeted re-query counts
    const mods = Array.from({ length: 40 }, (_, i) =>
      nexusMod({
        key: `mod-${i + 1}`,
        nexusModId: i + 1,
        nexusFileId: undefined,
        fileMD5: undefined,
      }),
    );
    const { fetchFn } = makeFetch({
      modStatuses: (_domain, requestedIds, callIndex) => {
        const all = Array.from({ length: 40 }, (_, i) => ({
          modId: i + 1,
          gameId: 1303,
          status: 'published',
        }));
        // first (big batch) call flakily drops mods 5, 17 and 30
        if (callIndex === 0) {
          return all.filter((row) => ![5, 17, 30].includes(row.modId));
        }
        return all;
      },
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts(mods);
    expect(verdicts.get('mod-5')!.state).toBe('CLEAN');
    expect(verdicts.get('mod-17')!.state).toBe('CLEAN');
    expect(verdicts.get('mod-30')!.state).toBe('CLEAN');
    expect([...verdicts.values()].filter((verdict) => verdict.state === 'FLAGGED')).toHaveLength(0);
  });

  it('flags a mod only when it stays absent through all verification rounds', async () => {
    const mods = [
      nexusMod({ key: 'alive', nexusModId: 1, nexusFileId: undefined, fileMD5: undefined }),
      nexusMod({ key: 'gone', nexusModId: 2, nexusFileId: undefined, fileMD5: undefined }),
    ];
    const { fetchFn, calls } = makeFetch({
      // mod 2 is genuinely deleted: never returned, on any call
      modStatuses: () => [{ modId: 1, gameId: 1303, status: 'published' }],
    });
    const provider = new NexusVerdictProvider(fetchFn as any);
    const verdicts = await provider.getVerdicts(mods);
    expect(verdicts.get('alive')!.state).toBe('CLEAN');
    expect(verdicts.get('gone')!.state).toBe('FLAGGED');
    // initial batch + at least one verification retry happened
    expect(calls.filter((query) => query.includes('legacyModsByDomain')).length).toBeGreaterThan(1);
  });

  it('throws on network failure (caller maps to ERROR)', async () => {
    const { fetchFn } = makeFetch({ failWith: { network: true } });
    const provider = new NexusVerdictProvider(fetchFn as any);
    await expect(provider.getVerdicts([nexusMod()])).rejects.toThrow('ECONNRESET');
  });

  it('throws on HTTP error status', async () => {
    const { fetchFn } = makeFetch({ failWith: { status: 429 } });
    const provider = new NexusVerdictProvider(fetchFn as any);
    await expect(provider.getVerdicts([nexusMod()])).rejects.toThrow('429');
  });

  it('throws on GraphQL-level errors', async () => {
    const { fetchFn } = makeFetch({ failWith: { graphError: 'something broke' } });
    const provider = new NexusVerdictProvider(fetchFn as any);
    await expect(provider.getVerdicts([nexusMod()])).rejects.toThrow('something broke');
  });
});
