import { actions, log, selectors, types } from 'vortex-api';

import { NexusVerdictProvider } from './safety/nexusProvider';
import { presentVerdict, Verdict, verdictLabel, VerdictState } from './safety/verdict';
import { VerdictService } from './service';

const CHECK_ID = 'mod-safety-verdict';

function registerSafetyColumn(context: types.IExtensionContext): void {
  // reads the attributes published by VerdictService after each scan
  context.registerTableAttribute('mods', {
    id: 'safety',
    name: 'Safety',
    description: 'Safety status based on the file\'s current state on nexusmods.com',
    help:
      'Checks the mod\'s file against nexusmods.com. Files deleted on the site, or whose ' +
      'mod page was removed, are flagged as potentially unsafe. "Caution" means the mod is ' +
      'currently under review by Nexus Mods moderation.',
    icon: 'shield',
    placement: 'both',
    calc: (mod: types.IMod) =>
      verdictLabel(mod.attributes?.['safetyVerdict'] as VerdictState | undefined),
    isToggleable: true,
    isSortable: true,
    isGroupable: true,
    isDefaultVisible: true,
    edit: {},
  });

  context.registerTableAttribute('mods', {
    id: 'safety-detail',
    name: 'Safety detail',
    description: 'Why the mod got its safety status',
    placement: 'detail',
    calc: (mod: types.IMod) => (mod.attributes?.['safetyVerdictReason'] as string) ?? '',
    edit: {},
  });
}

function notifyVerdict(
  api: types.IExtensionApi,
  gameId: string,
  vortexModId: string,
  verdict: Verdict,
): void {
  const state = api.getState();
  const mod = state.persistent.mods[gameId]?.[vortexModId];
  const name = (mod?.attributes?.['modName'] ??
    mod?.attributes?.['name'] ??
    vortexModId) as string;
  const flagged = verdict.state === 'FLAGGED';

  const notifActions: types.INotificationAction[] = [
    {
      title: 'Details',
      action: () => {
        api.showDialog?.(
          flagged ? 'error' : 'info',
          flagged ? 'Mod flagged as potentially unsafe' : 'Mod safety caution',
          {
            text:
              `${name}: ${verdict.reason}.\n\n` +
              (flagged
                ? 'Files that were removed from Nexus Mods may have been taken down for ' +
                  'safety reasons. It is recommended not to deploy this mod until you have ' +
                  'verified where it came from.'
                : 'This mod is being reviewed by Nexus Mods moderation. There is no malware ' +
                  'verdict yet - proceed with care.'),
          },
          [{ label: 'Close' }],
        );
      },
    },
  ];
  if (flagged) {
    notifActions.push({
      title: 'Disable',
      action: (dismiss) => {
        const profile = selectors.activeProfile(api.getState());
        if (profile !== undefined) {
          api.store?.dispatch(actions.setModEnabled(profile.id, vortexModId, false));
        }
        dismiss();
      },
    });
  }

  api.sendNotification?.({
    id: `mod-safety-${vortexModId}`,
    type: flagged ? 'error' : 'warning',
    title: flagged ? 'Potentially unsafe mod installed' : 'Installed mod is under review',
    message: `${name}: ${verdict.reason}`,
    actions: notifActions,
  });
}

async function runManualScan(api: types.IExtensionApi, service: VerdictService): Promise<void> {
  const notificationId = api.sendNotification?.({
    id: 'mod-safety-scan-progress',
    type: 'activity',
    message: 'Checking mod safety on nexusmods.com...',
  });
  try {
    const verdicts = await service.scanAll(api, true);
    const state = api.getState();
    const gameId = selectors.activeGameId(state);
    const mods = state.persistent.mods[gameId] ?? {};
    const nameOf = (modId: string) =>
      (mods[modId]?.attributes?.['modName'] ?? mods[modId]?.attributes?.['name'] ?? modId) as string;

    const byState = (wanted: VerdictState) =>
      [...verdicts.entries()]
        .filter(([, verdict]) => verdict.state === wanted)
        .map(([modId, verdict]) => `- ${nameOf(modId)}: ${verdict.reason}`);

    const flagged = byState('FLAGGED');
    const caution = byState('CAUTION');
    const unknown = byState('UNKNOWN');
    const errors = byState('ERROR');

    const sections: string[] = [`Checked ${verdicts.size} mods against nexusmods.com.`];
    if (flagged.length > 0) {
      sections.push(`FLAGGED (${flagged.length}):\n${flagged.join('\n')}`);
    }
    if (caution.length > 0) {
      sections.push(`Caution - under review (${caution.length}):\n${caution.join('\n')}`);
    }
    if (unknown.length > 0) {
      sections.push(`Unknown provenance (${unknown.length}):\n${unknown.join('\n')}`);
    }
    if (errors.length > 0) {
      sections.push(`Could not verify (${errors.length}):\n${errors.join('\n')}`);
    }
    if (flagged.length + caution.length + unknown.length + errors.length === 0) {
      sections.push('No problems found - every mod is available on the site.');
    }

    await api.showDialog?.(
      flagged.length > 0 ? 'error' : 'info',
      'Mod Safety scan results',
      { text: sections.join('\n\n') },
      [{ label: 'Close' }],
    );
  } catch (err) {
    api.showErrorNotification?.(
      'Mod safety scan failed',
      err instanceof Error ? err.message : String(err),
      { allowReport: false },
    );
  } finally {
    if (notificationId !== undefined) {
      api.dismissNotification?.('mod-safety-scan-progress');
    }
  }
}

function main(context: types.IExtensionContext): boolean {
  const service = new VerdictService(new NexusVerdictProvider());

  // Per-mod health check: Vortex iterates installed mods of the active game
  // and calls checkMod for each; all calls share one batched provider scan.
  context.registerHealthCheck({
    id: CHECK_ID,
    name: 'Mod Safety',
    description:
      'Checks each installed mod against its current status on nexusmods.com. ' +
      'Files that were deleted on the site, or whose mod page was removed, are flagged.',
    category: types.HealthCheckCategory.Mods,
    severity: types.HealthCheckSeverity.Critical,
    // Note: HealthCheckTrigger.Startup is never wired up by Vortex
    // 2.3.0-beta.1, so it is deliberately not used here. GameChanged fires
    // during startup once the game mode activates.
    triggers: [
      types.HealthCheckTrigger.Manual,
      types.HealthCheckTrigger.GameChanged,
      types.HealthCheckTrigger.ModsChanged,
    ],
    timeout: 60000,
    checkMod: async (api, mod) => {
      const started = Date.now();
      const verdict = await service.getVerdict(api, mod.modId);
      const presentation = presentVerdict(verdict);
      const name = (mod.attributes['modName'] ?? mod.attributes['name'] ?? mod.modId) as string;
      return {
        checkId: CHECK_ID,
        status: presentation.status,
        severity: presentation.severity as types.HealthCheckSeverity,
        message: `${name}: ${verdict.reason}`,
        metadata: { vortexModId: mod.modId, verdict: verdict.state },
        executionTime: Date.now() - started,
        timestamp: new Date(),
      };
    },
  });

  registerSafetyColumn(context);

  // Toolbar button on the Mods page ('mod-icons' group, positions 105-300
  // used by core) - forces a fresh scan and shows a summary.
  // Icon 'health' is the one Vortex core uses for the Health check page.
  context.registerAction(
    'mod-icons',
    300,
    'health',
    {},
    'Check Mod Safety',
    () => {
      void runManualScan(context.api, service);
    },
    () => selectors.activeGameId(context.api.getState()) !== undefined,
  );

  context.once(() => {
    // Install-time check: did-install-mod is a plain events.emit in Vortex
    // (NOT emitAndAwait), args (gameId, archiveId, modId, modInfo). The scan
    // signature includes the new mod, so getVerdict triggers a fresh lookup.
    context.api.events.on(
      'did-install-mod',
      (gameId: string, _archiveId: string, vortexModId: string) => {
        const activeGame = selectors.activeGameId(context.api.getState());
        if (gameId !== activeGame) {
          return;
        }
        void service
          .getVerdict(context.api, vortexModId)
          .then((verdict) => {
            if (verdict.state === 'FLAGGED' || verdict.state === 'CAUTION') {
              notifyVerdict(context.api, gameId, vortexModId, verdict);
            }
          })
          .catch((err) =>
            log('warn', 'mod-safety: install-time check failed', {
              modId: vortexModId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      },
    );

    log('info', 'mod-safety: extension loaded', { version: '0.4.0' });
  });

  return true;
}

export default main;
