# Nimi DSH

Nimi DSH brings the DeepSeek Harness desktop workspace into Nimi, connecting your local coding and file-work sessions to the AI models, integrations, and account access managed in Nimi Home.

## Getting Started

1. Sign in to **Nimi Home** and confirm at least one cloud AI connector (or an on-device text model in **Nimi Home → AI models**) is ready.
2. Open **Nimi DSH** from Nimi Home. If Home is signed out or Runtime is unavailable, DSH pauses behind an access gate with shortcuts to open Nimi Home and recheck access.
3. Choose a working directory on the new-session screen, pick a model from the composer dropdown, and start typing.

## Models & Reasoning Controls

- **Direct Cloud, Local & Saved Picker**: Open the model selector in the composer to switch between **All**, **Cloud**, **Local**, and **Saved** views and search by model or provider name. Picking any ready Cloud or Local model automatically reuses an existing matching configuration or creates a canonical named configuration for this app and binds only the current session to it.
- **Manage Named Configurations**: Open **Settings → Nimi models & access** (or the macOS application menu **Nimi Models & Access…**) to inspect machine-local model readiness, manage named text configurations, configure optional **Audio transcription (`audio.transcribe`)**, or open Nimi Home to add connectors and local models.
- **Configuration Drift Protection**: If a session's bound configuration is edited while a conversation is open, DSH pauses before sending the next turn (`AI_CONFIG_REVISION_CONFLICT`). Click **Adopt updated configuration** directly in the conversation (or in **Settings → Nimi models & access**) to acknowledge the new target and continue.
- **Reasoning Effort**: When the selected model exposes reasoning controls, adjust effort from the composer selector; switching models refreshes the available levels.

## Integrations, Home Chat & Activity

- **Granted Integrations**: Open **Settings → Integrations** to inspect services and operations that Nimi Home has granted to Nimi DSH. DSH exposes approved integrations to the agent without ever reading or storing provider credentials.
- **Continue a Nimi Home Chat**: Export a conversation in Nimi Home (`nimi.home-chat.v1`), then import its user and assistant messages and draft under **Settings → Nimi account**. Re-importing the same file opens the existing DSH session.
- **Home Activity**: When a session needs approval, finishes a turn, or reports a failure, Nimi DSH publishes a status update to **Nimi Home Activity**. Selecting an activity item returns directly to that DSH session.
- **Audio Transcription**: Once an `audio.transcribe` model is configured under **Settings → Nimi models & access**, the agent can transcribe workspace audio files through Nimi Runtime.

## Remote Web Companion

When Nimi DSH is running on your desktop and authorized in Nimi Home (`ai.nimi.dsh.sessions`), the Nimi DSH Web companion lets you list or create desktop sessions, submit idempotent follow-up instructions, watch live streaming progress, approve or decline pending tool actions with reviewer feedback, and transfer workspace files (up to 32 MiB per file).

To create a session from the Web companion, first add a workspace on the desktop. File transfers use the selected session’s workspace.

## Data & Privacy

- Session history, workspace bindings, and local app preferences are stored on this computer under your account-scoped `~/.nimi-dsh` directory.
- Working files stay in the workspace directory you choose.
- Prompts, relevant tool outputs, and optional audio files are sent through Nimi Runtime to the local or cloud model selected for that session. Cloud models receive that context over the connector configured in Nimi Home.

## Limitations & Help

- Nimi DSH Desktop is managed and updated by Nimi Home. Browser, terminal, and file tools run locally under your desktop user account.
- Subagent model allowlists only admit durable saved Nimi configurations (`Settings → Agent presets`).
- Optional standalone Web search uses its own tool configuration if enabled. Use `/export` in a conversation to save a local transcript for review.
