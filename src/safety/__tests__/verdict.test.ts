import {
  presentVerdict,
  verdictForFileCategory,
  verdictForModStatus,
  verdictForNexusFile,
  worstVerdict,
} from '../verdict';

describe('verdictForModStatus', () => {
  it('flags removed and wastebinned mods', () => {
    expect(verdictForModStatus('removed').state).toBe('FLAGGED');
    expect(verdictForModStatus('wastebinned').state).toBe('FLAGGED');
  });

  it('flags mods that no longer exist on the site', () => {
    expect(verdictForModStatus(undefined).state).toBe('FLAGGED');
  });

  it('marks under_moderation as CAUTION, not FLAGGED', () => {
    const verdict = verdictForModStatus('under_moderation');
    expect(verdict.state).toBe('CAUTION');
    expect(verdict.reason).toContain('no verdict yet');
  });

  it('ignores hidden and not_published (policy decision)', () => {
    expect(verdictForModStatus('hidden').state).toBe('CLEAN');
    expect(verdictForModStatus('not_published').state).toBe('CLEAN');
    expect(verdictForModStatus('publish_with_game').state).toBe('CLEAN');
    expect(verdictForModStatus('published').state).toBe('CLEAN');
  });
});

describe('verdictForFileCategory', () => {
  it('flags REMOVED files', () => {
    expect(verdictForFileCategory('REMOVED').state).toBe('FLAGGED');
  });

  it('treats benign categories as clean', () => {
    for (const cat of ['MAIN', 'UPDATE', 'OPTIONAL', 'OLD_VERSION', 'MISCELLANEOUS', 'ARCHIVED']) {
      expect(verdictForFileCategory(cat).state).toBe('CLEAN');
    }
  });

  it('treats an unlisted file as UNKNOWN', () => {
    expect(verdictForFileCategory(undefined).state).toBe('UNKNOWN');
  });
});

describe('verdictForNexusFile (combined)', () => {
  it('file REMOVED wins over mod published', () => {
    expect(verdictForNexusFile('REMOVED', 'published').state).toBe('FLAGGED');
  });

  it('mod removed wins over benign file', () => {
    expect(verdictForNexusFile('MAIN', 'removed').state).toBe('FLAGGED');
  });

  it('under_moderation with benign file is CAUTION', () => {
    expect(verdictForNexusFile('MAIN', 'under_moderation').state).toBe('CAUTION');
  });
});

describe('worstVerdict ordering', () => {
  it('FLAGGED > CAUTION > ERROR > UNKNOWN > CLEAN', () => {
    const clean = { state: 'CLEAN' as const, reason: '' };
    const unknown = { state: 'UNKNOWN' as const, reason: '' };
    const error = { state: 'ERROR' as const, reason: '' };
    const caution = { state: 'CAUTION' as const, reason: '' };
    const flagged = { state: 'FLAGGED' as const, reason: '' };
    expect(worstVerdict(clean, unknown).state).toBe('UNKNOWN');
    expect(worstVerdict(unknown, error).state).toBe('ERROR');
    expect(worstVerdict(error, caution).state).toBe('CAUTION');
    expect(worstVerdict(caution, flagged).state).toBe('FLAGGED');
    expect(worstVerdict(flagged, clean).state).toBe('FLAGGED');
  });
});

describe('presentVerdict', () => {
  it('never presents ERROR as passed', () => {
    const p = presentVerdict({ state: 'ERROR', reason: 'network down' });
    expect(p.status).not.toBe('passed');
  });

  it('FLAGGED is failed/critical', () => {
    expect(presentVerdict({ state: 'FLAGGED', reason: '' })).toEqual({
      status: 'failed',
      severity: 'critical',
    });
  });

  it('CAUTION is a warning', () => {
    expect(presentVerdict({ state: 'CAUTION', reason: '' })).toEqual({
      status: 'warning',
      severity: 'warning',
    });
  });

  it('UNKNOWN is visible but non-alarming', () => {
    expect(presentVerdict({ state: 'UNKNOWN', reason: '' })).toEqual({
      status: 'warning',
      severity: 'info',
    });
  });
});
