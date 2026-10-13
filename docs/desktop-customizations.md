# Desktop customizations

This fork is [PigeonAI-Yang/DeepSeek-Bot](https://github.com/PigeonAI-Yang/DeepSeek-Bot). It keeps the Windows Desktop changes in the plugin source at `ds-bot/src/client`.

The fork uses `ds-bot` package version `0.1.4`. The generated client is built from `ds-bot/src/client` with the existing `npm run build` workflow in `ds-bot/`.

## Install this fork

In DSH Desktop, enter `github:PigeonAI-Yang/DeepSeek-Bot#main&path:/ds-bot` as the plugin address. This uses the same GitHub package address format as the upstream README.

## Desktop changes

- The chat column and composer share a responsive width capped at 736px.
- Bot replies use flat text. User messages use soft bubbles in the same theme, capped at 80% width.
- Message actions appear below the message text.
- Group headers align member avatars and names with the admin label.
- The model menu is capped at 400px in height; a brain icon precedes the reasoning disclosure.
- The name capsule and downward runtime details form one panel with aligned edges. Header and group member dock share the existing member-work state.
- The Windows application menu uses DS Bot branding, and an available update appears as a cloud control in the title bar.
- The permission badge displays the active permission preset without changing it. Each Bot has its own model and reasoning-effort selectors.
- Composer controls use 28px buttons, symmetric 18px horizontal edge spacing and an 8px gap. The microphone stays on the left; waveform, send and stop share the right action area.
- The unconditional compatibility badge was removed.

## Configure the AMR provider

Use [`examples/desktop/cordis.patch.example.yml`](../examples/desktop/cordis.patch.example.yml) as a patch for the existing DSH Desktop profile. The `llm-pi-ai` entry replaces that plugin's full `config` object. Copy the current settings and all provider entries into the patch before adding `amr-openai`. Do not replace the profile with only this example.

Set `AMR_API_KEY` in DeepSeek Harness's local credentials UI. The example refers to the credential by name and contains no key value.

The sample sets `contextWindow` to `1000000`. This is the configured value; support depends on the selected provider route. The reasoning fields describe request compatibility. Accepting a reasoning-effort field does not measure model compute performance.

The retry policy retries `EMPTY_RESPONSE`, `SERVER`, `TIMEOUT`, and `TRANSPORT` failures up to five times in `normal` mode. It does not include `AUTH` or rate-limit failures.

## Launch Desktop directly

Fully quit DSH before using either launcher. The PowerShell script stops if the same executable path is already running and asks you to exit DSH. It does not close DSH for you.

Pass the full executable path to the PowerShell launcher:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Start-DS-Bot-Direct.ps1 -ApplicationPath 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
```

The VBScript launcher takes the executable path as its first argument:

```powershell
wscript.exe .\scripts\windows\Start-DS-Bot-Direct.vbs "C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"
```

The launcher adds `amr-link.open-design.ai` to the launched process's `NO_PROXY` and `no_proxy` values. It removes `ELECTRON_RUN_AS_NODE` from that process and leaves the inherited HTTP, HTTPS, and ALL proxy variables unchanged. The default bypass applies only to the AMR host.

To inspect the process environment without starting DSH, add `-VerifyEnvironment` to the PowerShell command. The script prints JSON with the proxy-preservation and `NO_PROXY` checks.

## Preserve existing Desktop data

The existing Desktop home and chat data remain at the current junction target. If you move the DSH home, quit DSH completely and make a backup first. Preserve workspace IDs and register each workspace with its canonical, resolved working-directory path so bots can keep attaching to the existing workspace.

If pnpm reports a store mismatch, use the same explicit `--store-dir` for install and link commands. Do not delete the pnpm store or cache to resolve the mismatch.
