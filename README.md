# Vortex Mod Safety

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that shows a **safety verdict** for every installed mod, based on the file's *current* status on nexusmods.com — before it gets deployed into your game folder.

The core idea: **if a file has been deleted on Nexus Mods, it is potentially malware.** Files get taken down for safety reasons; a copy sitting in your mod staging folder doesn't know that. This extension asks the site.

## What you get

- **Safety column on the Mods table** — Clean / FLAGGED / Caution / Unknown per mod (sortable, groupable), with the reason shown in the mod's detail panel.
- **Health check** — a per-mod "Mod Safety" check on Vortex's Health check page (Ctrl+Shift+H). Runs automatically on startup, on game switch, and after installing/removing mods.
- **Install-time warning** — the moment you install a mod whose file was removed from the site, you get an error notification with *Details* and *Disable* actions.
- **"Check Mod Safety" toolbar button** on the Mods page — forces a fresh scan and shows a summary dialog.

## Verdict states

| State | Meaning | Presentation |
|---|---|---|
| `CLEAN` | File and mod page are available on nexusmods.com | passed |
| `FLAGGED` | File was deleted on the site, or the whole mod was removed/wastebinned, or the mod no longer exists | failed / critical + notification |
| `CAUTION` | Mod is under review by Nexus Mods moderation — no verdict yet | warning |
| `UNKNOWN` | Not a Nexus download and hash not known to the site | visible, non-alarming |
| `ERROR` | Lookup failed (network etc.) — **never presented as safe** | visible error |

Policy notes:
- Mods that are `hidden` or `not_published` are deliberately **not** flagged (routine author actions).
- The site does not record *who* deleted a file — moderation takedowns and authors cleaning up old versions both show as removed. On installs with very old files you may see flags that are just author cleanup.

## How it looks things up

Identity first, hashes as fallback, nothing uploaded anywhere:

1. Nexus-sourced mods are identified by `(game domain, mod id, file id)` from Vortex's own state.
2. Every Vortex download already has an MD5 (`fileMD5` attribute); manually added archives are matched by that hash.
3. Lookups go to the nexusmods.com GraphQL v2 API (`https://api.nexusmods.com/v2/graphql`) as **batched POST requests** — hashes and ids only ever travel in the request body, never in a URL. No API key required for these public queries; typically 2–3 requests per full scan.

## Building

```
npm install --legacy-peer-deps
npm test          # jest unit tests for the pure logic (no Vortex needed)
npm run build     # webpack -> dist/index.js + info.json
```

Type definitions come from `@nexusmods/vortex-api` (pinned to the Vortex version this was built against). `vortex-api` itself is a webpack external — Vortex injects it at runtime; never bundle it. `--legacy-peer-deps` is needed because the typings package pins react 16 peers.

## Installing into Vortex

```
npm run deploy
```

copies `dist/` to `%APPDATA%\Vortex\plugins\vortex-mod-safety\`. Restart Vortex, then check:

1. **Extensions** page lists "Mod Safety".
2. `%APPDATA%\Vortex\vortex.log` contains `mod-safety: extension loaded` and, once a game is active, `mod-safety: scan complete {...}`.
3. The Mods table has a **Safety** column (enable it via the table's column toggle if hidden).
4. The Mods page toolbar has **Check Mod Safety**.

To test the install-time warning without real malware: install any mod whose file has since been deleted on the site, or wire up the `MockVerdictProvider` (see `src/safety/provider.ts`) which flags mods whose name contains `FLAGME`.

## Architecture

```
src/
  index.ts               wiring: health check, table column, toolbar action,
                         did-install-mod handler (the only files importing vortex-api)
  service.ts             VerdictService: gathers identities from Redux state,
                         dedupes concurrent checks into one batched scan,
                         caches 10 min, publishes results to mod attributes
  safety/                PURE modules - no vortex-api imports, jest-tested
    identity.ts          mod attributes -> lookup identity
    verdict.ts           status -> verdict mapping + presentation
    provider.ts          VerdictProvider interface + MockVerdictProvider
    nexusProvider.ts     GraphQL v2 implementation (fetch injectable)
```

## Verified API facts (Vortex 2.3.0-beta.1)

Everything below was verified against the Vortex source at tag `v2.3.0-beta.1` and/or live behavior — not guessed:

- `registerHealthCheck(IModHealthCheck)` is the modern diagnostics surface (docs mark `registerTest` legacy). Per-mod results aggregate worst-first.
- **`HealthCheckTrigger.Startup` is never wired up** by `setupAutomaticTriggers()` — a check using only it silently never runs. `GameChanged` fires during startup instead.
- `did-install-mod` is a plain `api.events.emit` (args `gameId, archiveId, modId, modInfo`) — an `onAsync` handler would never fire. `will-install-mod` / `will-deploy` are the `emitAndAwait` ones.
- Mods table id is `mods`; Mods-page toolbar action group is `mod-icons`.
- Scan results are written to mod attributes (`safetyVerdict`, `safetyVerdictReason`) via `actions.setModAttributes` + `util.batchDispatch`, which is what makes the table column reactive.

Nexus GraphQL v2 quirks discovered while building (worth knowing if you touch `nexusProvider.ts`):

- Page types cap every response at **80 nodes** regardless of `count`; `totalCount` is accurate — you must offset-paginate.
- Large `legacyModsByDomain` batches **randomly drop rows that exist**. Absence from one batch must never be treated as "deleted" — the provider re-verifies missing ids in two extra rounds of small batches before flagging.
- `modFilesByUid` is unreliable (returned data once, then consistently empty for the same uid) — not used.
- One MD5 can match many uploads (`fileHashes`); matches are disambiguated by mod/file id or file size.

## Not built (yet)

- Settings page (cache TTL, policy toggles) — there is currently nothing that needs configuring.
- Suppressing install-time notifications during collection installs.
- Distinguishing author-deleted old files from moderation takedowns (needs a site-side signal).
