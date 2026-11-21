# Nimi DSH

Nimi DSH adapts the open-source [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop coding and agent workspace for Nimi, connecting local workspace sessions, file and terminal tools, and a remote Web companion to the AI models, integrations, and account access managed in Nimi Home.

## Getting Started

1. Install **Nimi DSH** from the Nimi Home Catalog on a supported desktop (**Windows x64** or **macOS arm64**).
2. Sign in to **Nimi Home** and verify that at least one cloud AI connector or on-device text model under **Nimi Home → AI models** is ready.
3. Open **Nimi DSH** from Nimi Home. If Home is signed out or Runtime is unavailable, Nimi DSH pauses behind an access gate with shortcuts to open Nimi Home and recheck access.
4. Add or choose a local workspace directory on the desktop, select a model from the composer dropdown, and start a session.

## Models & Reasoning Controls

- **Direct Cloud, Local & Saved Picker**: Switch between **All**, **Cloud**, **Local**, and **Saved** views in the composer model selector and search by model or provider name. Picking a ready cloud or local model reuses a matching configuration or creates a named configuration for Nimi DSH and binds only the current session to it.
- **Manage Named Configurations**: Open **Settings → Nimi models & access** (or the macOS application menu **Nimi Models & Access…**) to inspect machine-local model readiness, manage named text configurations, configure optional **Audio transcription (`audio.transcribe`)**, or jump to Nimi Home to add connectors and local models.
- **Configuration Drift Protection**: If a session's bound configuration is modified while a conversation is open, Nimi DSH pauses before sending the next turn (`AI_CONFIG_REVISION_CONFLICT`). Select **Adopt updated configuration** in the conversation or settings to acknowledge the new target and continue.
- **Reasoning Effort**: When the selected model exposes reasoning controls, adjust effort directly in the composer; switching models refreshes the available levels.

## Remote Web Companion

When Nimi DSH Desktop is running on your primary PC and authorized in Nimi Home (`ai.nimi.dsh.sessions`), the Nimi DSH Web companion lets you connect from a browser with the same Nimi account to:

- List existing desktop sessions or create a new session in a desktop-configured workspace.
- Submit idempotent follow-up instructions and watch live streaming progress.
- Review concrete tool action proposals (including file writes, edits, and commands) and approve or deny them with optional reviewer feedback.
- Browse, upload, and download workspace files (up to 32 MiB per file).

**Desktop workspace prerequisite**: Before creating a new session from the Web companion, add at least one workspace in Nimi DSH Desktop and keep Nimi DSH Desktop running on your primary PC. First-time browser access requires source confirmation and scoped `ai.nimi.dsh.sessions` integration authorization in Nimi Home.

## Integrations, Home Chat & Activity

- **Granted Integrations**: Open **Settings → Integrations** to inspect services and operations granted by Nimi Home. Nimi DSH exposes approved integrations to the agent without reading or storing provider credentials.
- **Continue a Nimi Home Chat**: Export a conversation in Nimi Home (`nimi.home-chat.v1`) and import it under **Settings → Nimi account**. Re-importing the same export reopens the existing DSH session.
- **Home Activity**: When a session needs approval, finishes a turn, or encounters an error, Nimi DSH posts a status item to **Nimi Home Activity** so you can jump straight back to that session.
- **Audio Transcription**: When an `audio.transcribe` model is configured under **Settings → Nimi models & access**, the agent can transcribe workspace audio files through Nimi Runtime.

## Data & Privacy

- Session history, workspace bindings, and local app preferences are stored on your desktop under your account-partitioned `~/.nimi-dsh` directory.
- Working files stay in the local workspace directories you explicitly choose.
- Prompts, tool outputs, and optional audio files are sent through Nimi Runtime to the local or cloud model selected for that session. Cloud models receive that context via the connector configured in Nimi Home.
- Upstream product telemetry, feedback reporting, and standalone auto-update plugins are disabled in the Nimi-managed desktop package.

## Limitations & Attribution

- **Supported host platforms**: Native Nimi DSH Desktop is packaged for **Windows x64** and **macOS arm64**. Browser, terminal, and file tools execute locally under your desktop user account.
- **Web companion availability**: The Web companion does not run agents in the cloud; it requires your primary PC to be online with Nimi Home and Nimi DSH Desktop running.
- **Subagent presets**: Subagent model allowlists only admit durable saved Nimi configurations (**Settings → Agent presets**).
- **Upstream & License**: Adapted from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) under the MIT License. Report Nimi integration issues at [github.com/nimiplatform/deepseek-harness/issues](https://github.com/nimiplatform/deepseek-harness/issues).
