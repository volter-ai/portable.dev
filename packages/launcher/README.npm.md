# Portable — use Claude Code from your phone

**Portable** runs on your computer and phone, letting you use Claude Code from anywhere.
Run it on **your own PC** with one command (`portable`); your repos, chats, and data live
locally; and you drive it from the **Portable mobile app** by scanning a QR code.

Portable uses your own Claude subscription — it costs nothing extra.

100% free, open source, and fully private — we do not see any of your data or AI chats.

## Install

```bash
bun install -g @volter-ai/portable.dev
# or
npm install -g @volter-ai/portable.dev
# or
curl -fsSL https://portable.dev/install.sh | bash
```

Requires [Bun](https://bun.sh) ≥ 1.2 (both the CLI and the local api run under Bun; the
install scripts set it up for you).

## Quickstart

```bash
portable        # → prints a pairing QR in your terminal
```

Then install the mobile app, sign in, and **scan the QR**:

- [App Store](https://apps.apple.com/us/app/portable-dev/id6758861546)
- [Google Play](https://play.google.com/store/apps/details?id=dev.portable.app)

In the happy path there is **nothing to configure**: the launcher discovers the Claude and
GitHub credentials already on your machine (the `claude` CLI's login, `gh`, your git
credential helper), provisions cloudflared and Chromium on first run, and pairs purely from
the QR. Re-opening the app later reconnects automatically — no re-scan needed.

## Commands

| Command              | What it does                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portable`           | Default. Auto-links the current dir (only if it's a git repo inside your home dir), then starts the runtime and shows the pairing QR. Runs until Ctrl-C. |
| `portable connect`   | Same as bare `portable` (the canonical "start the runtime" name). `portable start` is a back-compat alias.                                               |
| `portable link`      | Register the **current directory** as a Portable project so it shows up in the app (git repo required).                                                  |
| `portable unlink`    | Remove the current directory from your Portable projects.                                                                                                |
| `portable --version` | Print the installed CLI version.                                                                                                                         |
| `portable help`      | Show help (`--help` / `-h`).                                                                                                                             |

Flags: `--debug` / `-d` streams the api logs to your terminal (useful to watch your phone
connect) and prints the QR once instead of the live screen.

## How it works

Portable is **local-first**. The backend runs on **your PC**, bound to `127.0.0.1`, storing
everything in local SQLite — no Docker, no Postgres, no cloud database. The launcher
publishes it through a Cloudflare Quick Tunnel and registers that URL with a public relay;
the mobile app talks to a stable address on the relay, which reverse-proxies to your PC. The
relay never holds your AI credential or your data — it only forwards traffic. AI calls go
**direct** to `api.anthropic.com` with your own Claude account.

To keep everything on infrastructure you control, you can self-host the relay and point the
CLI at it with `PORTABLE_RELAY_URL`.

## Links

- **Source & docs:** [github.com/volter-ai/portable.dev](https://github.com/volter-ai/portable.dev)
- **Patch notes:** [CHANGELOG.md](https://github.com/volter-ai/portable.dev/blob/main/CHANGELOG.md)
- **Configuration reference (`.env`), credentials, troubleshooting:** the
  [repository README](https://github.com/volter-ai/portable.dev#readme)

## License

Apache-2.0
