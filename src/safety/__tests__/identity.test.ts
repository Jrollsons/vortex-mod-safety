import { extractIdentity, hasNexusIdentity } from '../identity';

describe('extractIdentity', () => {
  it('extracts a full Nexus identity', () => {
    const id = extractIdentity(
      'smapi-vortex-id',
      {
        source: 'nexus',
        modId: 2400,
        fileId: 130874,
        downloadGame: 'stardewvalley',
        fileMD5: 'AB847DCD8272685A56AC3DCF2E5EA37B',
        fileSize: 4200000,
        modName: 'SMAPI',
      },
      '',
      'stardewvalley',
    );
    expect(hasNexusIdentity(id)).toBe(true);
    expect(id.nexusModId).toBe(2400);
    expect(id.nexusFileId).toBe(130874);
    expect(id.gameDomain).toBe('stardewvalley');
    expect(id.fileMD5).toBe('ab847dcd8272685a56ac3dcf2e5ea37b'); // normalized
    expect(id.name).toBe('SMAPI');
  });

  it('accepts string-typed modId/fileId (state is not always clean)', () => {
    const id = extractIdentity(
      'x',
      { source: 'nexus', modId: '2400', fileId: '99', downloadGame: 'stardewvalley' },
      '',
      'stardewvalley',
    );
    expect(id.nexusModId).toBe(2400);
    expect(id.nexusFileId).toBe(99);
  });

  it('falls back to the game domain when downloadGame is missing', () => {
    const id = extractIdentity('x', { source: 'nexus', modId: 5 }, '', 'skyrimse');
    expect(id.gameDomain).toBe('skyrimse');
  });

  it('manually added archive: hash only, no nexus identity', () => {
    const id = extractIdentity(
      'manual-mod',
      { fileMD5: 'd41d8cd98f00b204e9800998ecf8427e', fileSize: 123 },
      '',
      'stardewvalley',
    );
    expect(hasNexusIdentity(id)).toBe(false);
    expect(id.fileMD5).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('rejects malformed md5 values', () => {
    const id = extractIdentity('x', { fileMD5: 'not-a-hash' }, '', 'g');
    expect(id.fileMD5).toBeUndefined();
  });

  it('no attributes at all: identity-less', () => {
    const id = extractIdentity('bare', {}, '', 'g');
    expect(hasNexusIdentity(id)).toBe(false);
    expect(id.fileMD5).toBeUndefined();
    expect(id.name).toBe('bare');
  });

  it('marks collections', () => {
    const id = extractIdentity('coll', {}, 'collection', 'g');
    expect(id.isCollection).toBe(true);
  });

  it('nexus source without modId yields no nexus identity', () => {
    const id = extractIdentity('x', { source: 'nexus' }, '', 'g');
    expect(hasNexusIdentity(id)).toBe(false);
  });
});
