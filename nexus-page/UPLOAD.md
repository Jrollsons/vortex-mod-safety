# Uploading to Nexus Mods — checklist

Site extensions live under the **"site" game domain**: https://www.nexusmods.com/site
(category: **Vortex**). Vortex's Extensions browser reads from there, which also
gives users in-app install and update notifications — something GitHub releases can't do.

## Fields

| Nexus field | Use |
|---|---|
| Name | `Mod Safety` |
| Brief overview | contents of `description-short.txt` (fits the 255-char limit) |
| Description | contents of `description-long.bbcode.txt` (paste as-is, it's BBCode) |
| Category | Vortex |
| Language | English |
| Permissions | your call — repo is GPL-3 |

## Images (in this order)

1. `banner.png` — set as the primary/header image (1920x1080)
2. `shot-startup.png` — full Vortex window: startup scan notification + Safety column + toolbar button
3. `shot-column.png` — mod list showing Clean and Unknown verdicts side by side
4. `shot-notification-crop.png` — close-up of the "all clear" notification
5. `shot-toolbar-crop.png` — close-up of the toolbar with Check Mod Safety

Worth adding manually (needs a click, so couldn't be captured automatically):
- The **summary dialog** — click *Check Mod Safety* on the Mods page toolbar and
  screenshot the results dialog.
- A **flagged mod** — if you have access to a test file that was removed from the
  site, a screenshot of the red FLAGGED notification + column entry is the money shot.

## File to upload

The release zip from GitHub (`vortex-mod-safety-0.5.1.zip`) — Vortex installs
site-extension archives directly, and the zip already has `index.js` + `info.json`
at its root, which is the layout Vortex expects.

- File version: match `info.json` (0.5.1)
- Tick "This is the latest version"

## After publishing

Consider adding the Nexus mod page URL to the GitHub README, and (optionally)
`requireVersion('>=2.3.0-beta.1')` before wide distribution so pre-health-check
Vortex versions fail gracefully rather than erroring on load.
