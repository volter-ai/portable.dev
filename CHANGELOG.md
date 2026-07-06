# Changelog

Patch notes for the Portable CLI, published to npm as
[`@volter-ai/portable.dev`](https://www.npmjs.com/package/@volter-ai/portable.dev).
Versions follow the monorepo release version.

## [3.5.0] - 2026-07-04

### Added

- End-to-end encryption between the mobile app and your PC. Everything — API requests
  and the live connection — is now encrypted directly between your phone and your PC,
  so the relay only ever forwards ciphertext.
- Cross-surface presence and session hand-off: Claude Code sessions started in your
  terminal show up live in the Portable app, and a conversation can be picked up on
  either surface without forking its history.
- `portable --version` (also `-v`) prints the installed CLI version.
- Log out directly from the "can't reach your PC" screen.

### Changed

- The "Update available" prompt is now dismissible and no longer blocks the app —
  dismiss it to keep working and it stays hidden for 24 hours.

### Fixed

- Chat-list previews no longer show internal `<task-notification>` text.
- When Claude asks several questions at once, the Submit button stays reachable and the
  keyboard no longer covers the input.

## [3.4.0] - 2026-07-02

### Added

- Switch the AI model mid-chat without restarting the session.
- Set the reasoning depth per chat with `/effort`.
- Choose your default model and permission mode for new chats from the home screen.

### Changed

- File edits in a chat are grouped into a single display, like sub-agents.

### Fixed

- More reliable QR pairing — a scanner viewfinder, clear scan feedback, and no more
  stuck "success" state.
- A chat keeps its own permission mode instead of reverting to the default when you
  leave and come back.
