/**
 * Extracts a lookup identity from a mod's Vortex attributes.
 * Pure module: no vortex-api imports.
 *
 * Attribute names verified against Vortex 2.3.0-beta.1
 * (ICommonModAttributes in mod_management/types/IMod.ts).
 */

export interface ModIdentity {
  /** Vortex mod id - the key in state.persistent.mods[gameId]. */
  key: string;
  /** Display name for messages. */
  name: string;
  /** Nexus game domain (from downloadGame), when Nexus-sourced. */
  gameDomain?: string;
  /** Numeric Nexus mod id, when Nexus-sourced. */
  nexusModId?: number;
  /** Numeric Nexus file id, when Nexus-sourced. */
  nexusFileId?: number;
  /** MD5 of the download archive, when Vortex recorded one. */
  fileMD5?: string;
  /** Archive size in bytes, used to disambiguate MD5 multi-matches. */
  fileSize?: number;
  /** Collections are curated by Nexus - skipped by the safety check. */
  isCollection: boolean;
}

function asPositiveInt(value: unknown): number | undefined {
  const num = typeof value === 'string' ? parseInt(value, 10) : (value as number);
  return typeof num === 'number' && Number.isFinite(num) && num > 0 ? num : undefined;
}

function asMD5(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function extractIdentity(
  key: string,
  attributes: Record<string, unknown>,
  modType: string | undefined,
  fallbackGameDomain: string,
): ModIdentity {
  const attr = attributes ?? {};
  const name =
    (attr['customFileName'] as string) ??
    (attr['modName'] as string) ??
    (attr['logicalFileName'] as string) ??
    (attr['fileName'] as string) ??
    (attr['name'] as string) ??
    key;

  const identity: ModIdentity = {
    key,
    name,
    fileMD5: asMD5(attr['fileMD5']),
    fileSize: asPositiveInt(attr['fileSize']),
    isCollection: modType === 'collection',
  };

  if (attr['source'] === 'nexus') {
    const nexusModId = asPositiveInt(attr['modId']);
    const nexusFileId = asPositiveInt(attr['fileId']);
    if (nexusModId !== undefined) {
      identity.nexusModId = nexusModId;
      identity.nexusFileId = nexusFileId;
      identity.gameDomain =
        typeof attr['downloadGame'] === 'string' && attr['downloadGame'] !== ''
          ? (attr['downloadGame'] as string)
          : fallbackGameDomain;
    }
  }

  return identity;
}

export function hasNexusIdentity(
  id: ModIdentity,
): id is ModIdentity & { gameDomain: string; nexusModId: number } {
  return id.gameDomain !== undefined && id.nexusModId !== undefined;
}
