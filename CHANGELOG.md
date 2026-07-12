# Changelog

Patch notes for the Portable CLI, published to npm as
[`@volter-ai/portable.dev`](https://www.npmjs.com/package/@volter-ai/portable.dev).
Versions follow the monorepo release version.

## [3.5.3] - 2026-07-11

### Added

- Source Control on the repo page: browse the commit history graph, review your changes
  with full diffs, then stage, discard, commit, push, and pull — all from your phone.
- Worktree support: see a repo's worktrees, switch the Source Control view between them
  with a searchable branch picker, push and pull a worktree's branch (with merge-conflict
  protection), and start a chat that runs directly inside a worktree.
- A new Files tab hosts the repo file tree.

### Changed

- Repo tabs were reordered, and the Overview is now a pinned dashboard with more room for
  your recent chats.
- Source Control refreshes automatically when you come back to it, and supports
  pull-to-refresh.

## [3.5.2] - 2026-07-08

### Added

- Sign in with your Claude account right from the app — open Settings → Claude Account,
  or type `/login` in the composer, to connect (or reconnect) your Anthropic account
  without touching your PC. Portable keeps the session alive by refreshing the token for
  you.

### Fixed

- Credential problems no longer leak raw internal text into the chat. You now get a clear
  message with a sign-in button instead — covering both a missing credential and an
  expired or revoked one.

## [3.5.1] - 2026-07-07

### Added

- `portable --ngrok` (or `PORTABLE_TUNNEL_PROVIDER=ngrok`) fronts your PC with an ngrok
  tunnel instead of Cloudflare. ngrok must already be installed and authenticated.
  Available on Windows, macOS, and Linux.

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
