---
description: "Develop the Nimi DSH desktop application and inspect its current verification scope."
kind: package-reference
---

# Nimi DSH

English | [中文](README.zh.md)

The Nimi App project adopts the DeepSeek Harness desktop product from upstream version `0.2.2-rc.3`. DSH owns the Electron build, desktop UI, plugins and RunAsNode worker. App Tools owns the Nimi declaration and installable archive. The two projects retain their respective pnpm versions and use the same SDK and Kit candidates.

`pnpm install --frozen-lockfile` installs the pinned local platform packages. After editing App declarations, run `pnpm exec nimi-app sync` and `pnpm exec nimi-app check`. Run `pnpm exec nimi-app test` for the adapter checks.

For day-to-day development, open Nimi Home with Developer Mode enabled and run `pnpm dev` from this directory. App Tools supervises the Electron Host. The development build reuses DSH's renderer build and runtime preparation. Set the text model for the development registration under **Apps → Nimi DSH → AI models**. For an existing registration, use `pnpm dev -- --list-registrations` and `pnpm dev -- --resume <selector>`.

In the DSH workspace, open **Settings → Nimi models and access → Open Nimi settings**. This window uses Kit’s App session, access gate, NimiAppChrome and App AIConfig editor on the existing protected Host. The upstream workspace retains its own navigation, plugins and session log. The model picker reads this registration’s effective selection. On macOS the application menu also offers the settings entry.

The reasoning-effort menu reads the same exact selection through the existing Host IPC. A saved effort is resolved again for each step, including after the selected route changes. An omitted effort leaves Nimi’s configured default in effect.

The shell runs on the Electron selected by Home. The development Worker uses the Electron executable pinned by DSH because its native plugin loader matches specific Electron versions. The Worker remains a child of the App and requests model steps through its existing private IPC channel.

On macOS arm64, the first development session returned the requested response and generated its title via the configured Home route. Runtime recorded both calls for `ai.nimi.dsh`. The same development registration reopened the conversation after a supervised Host restart.

The DSH development App wrote and read back a real workspace file. A stopped foreground shell command left its delayed marker absent. Both in-process delegation tools completed model-backed child tasks. A second development registration started with its own default workspace under its Nimi storage namespace and displayed an empty session list.

For local macOS development the App and Worker use Kit `0.24.0-rc.15.scope.1` with its matching native carrier and source Runtime. The Host observes the active account's session lifetime. On sign-out the old workspace and previews close, then the Worker exits. Resume the same development registration after signing in to load the current account's history and drafts.

Each desktop workspace load reads the current plugin scripts from its authenticated Worker. Imported thinking stays in the history view. Requests to Nimi retain the other source’s public answer and paired tool results, while reasoning replay belongs to the route that produced it.

The Nimi model adapter advertises the text transport's 128-message and 1 MiB ceilings. Each DSH session preset uses them when selecting a complete history span for summarization. In the desktop development app, a local import of 65 short exchanges resumed through the configured Nimi model, which recalled a handoff reference and time recorded only in the first exchange. The file-based import plugin was switched off again afterwards.

A visual test used the Home-configured GPT-6 Luna route. DSH read a real synthetic PNG as a tool result, sent the image through Nimi, and returned the correct band colors. The manual `/compact` command produced a checkpoint and the next turn recalled those colors.

The macOS development profile also ran Playwright MCP in an isolated headless Chrome session when the installed executable was available. The App navigated to a local Nimi page, saved a real PNG screenshot, and the model reported its visible heading. Playwright uses its own short socket directory. Native Computer Use is a separate opt-in plugin with macOS permissions owned by its helper.

Native Computer Use passed on the authorized TextEdit test window after the user granted Accessibility and Screen Recording to the development helper. DSH queried both permissions, selected the exact window, read its accessibility tree and returned its screenshot through Nimi. It then appended a verification line through native UI input, saved the test document and captured the updated window. The file bytes include that line.

For the macOS arm64 candidate, run `pnpm exec nimi-app build --target macos-aarch64`, then `pnpm exec nimi-app pack --target macos-aarch64 --production`. This invokes the existing DSH Electron packaging and wraps its resulting bundle in a local Nimi package. Install it from **Apps → Add App → Import local package**. Choose the text model in Home. The model bridge uses the current App session and scopes DSH home to the App's managed storage namespace.

The local candidate and upstream publication use separate workflows. The candidate build targets macOS arm64.

On macOS arm64, Home imported and launched `0.2.2-rc.3.20261118.1`. The packaged RunAsNode worker opened a new session, produced its first reply and generated the title through two successful DeepSeek Flash turns in Nimi Runtime. The installed source reopened with both the title and reply intact. The original Luna route initially returned a provider availability error. After restoring it in Home, another new installed session generated a lighthouse welcome and its title through two successful Luna calls in Nimi Runtime. This was a local import against the source Runtime.

The next local candidate, `0.2.2-rc.3.20261118.2`, uses SDK rc.7 and Kit rc.11. The managed profile leaves distribution to Nimi Home and disables the upstream feedback and product analytics plugins. Local session export remains available. The development settings page and a reopened conversation passed. Home updated the imported copy from .1 to .2 and launched it with the original sessions intact. The installed Worker generated a title and queried real Computer Use permissions through a model turn. Its default CUA helper receipt selects the development bundle. The .2 verification used the supported helperPath override pointing to the release helper in the same package. After the user granted Accessibility and Screen Recording to the release helper, the installed App returned a 1346 × 878 WebP from the designated TextEdit window. The model transcribed all three lines correctly. The user authorized TextEdit for that session only. The .3 local build stages and validates the release helper separately; its install has not been exercised.
