/**
 * Headless render preview for the launcher's terminal UI — the fast UI-iteration
 * loop. Mounts a screen with Ink against a NON-TTY fake stdout (so Ink writes full
 * frames), captures the last frame, strips ANSI, and prints it as plain text.
 *
 *   bun --cwd packages/launcher preview                 # connected screen, 112x40
 *   bun --cwd packages/launcher preview 100 24          # connected at 100x24
 *   bun --cwd packages/launcher preview 120 44 booting  # booting / pairing / connected
 *   bun --cwd packages/launcher preview 120 44 connected nodevice|device
 *
 * This is a DEV tool only (never bundled). For a real end-to-end run from source
 * use `bun run portable` (which spawns the api from source too — no build/install).
 */
import { EventEmitter } from 'events';

import { render } from 'ink';
import { createElement as h } from 'react';

import { renderTerminalQr, RootScreen, type RootScreenProps } from '../src/TerminalUi.js';

// eslint-disable-next-line no-control-regex -- stripping ANSI requires the ESC control char
const ANSI = new RegExp('\\u001b\\[[\\d;?]*[A-Za-z]', 'g');

const COLS = Number(process.argv[2] || 112);
const ROWS = Number(process.argv[3] || 40);
const PHASE = (process.argv[4] || 'connected') as RootScreenProps['phase'];
const DEVICE = process.argv[5] === 'device';

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  read() {
    return null;
  }
}

const frames: string[] = [];
const fakeStdout = Object.assign(new EventEmitter(), {
  columns: COLS,
  rows: ROWS,
  write: (s: string) => {
    frames.push(s);
    return true;
  },
});

const now = Date.now();
const mk = (title: string, repo: string, ms: number) => ({
  id: title,
  title,
  repoFullName: repo,
  lastUpdated: new Date(now - ms).toISOString(),
});
const chats = [
  mk('Untitled chat', 'oliver-io/unreal-mcp', 2 * 60_000),
  mk('Plan arena v2 with new materials and lighting', 'oliver-io/unreal-mcp', 3_600_000),
  mk('portable-rc mobile-vgit', 'volter-ai/mobile-vgit', 3 * 3_600_000),
  mk('Investigate multiplayer networking issue', 'oliver-io/unreal-mcp', 28 * 3_600_000),
  mk('Find the gemini review skill', 'oliver-io/unreal-mcp', 30 * 3_600_000),
  mk('Fix Windows portable build startup error', 'oliver-io/unreal-mcp', 2 * 86_400_000),
  mk('can we find the refactor loop for data sync?', 'volter-ai/mobile-vgit', 2 * 86_400_000),
  ...Array.from({ length: 25 }, (_, i) =>
    mk(
      `Older chat ${i}`,
      i % 2 ? 'volter-ai/mobile-vgit' : 'oliver-io/unreal-mcp',
      (5 + i) * 86_400_000
    )
  ),
];

async function main() {
  const qr = await renderTerminalQr(
    JSON.stringify({ gatewayBase: 'https://app.portable.dev', pcId: 'pc_demo', token: 'jwt' })
  );
  const props: RootScreenProps = {
    phase: PHASE,
    status: 'Opening a secure tunnel…',
    qr,
    endpoint: 'https://app.portable.dev/t/pc_71c8',
    pcId: 'pc_71c8d960646c43b69900156d503ed77b',
    label: 'deskie11',
    lastConnectedAt: new Date(now - 2 * 3_600_000).toISOString(),
    devices: DEVICE
      ? [
          {
            id: 's1',
            name: 'Apple iPhone 15 Pro',
            appVersion: '1.0.27',
            connectedAt: new Date(now - 5 * 60_000).toISOString(),
          },
        ]
      : [],
    chats,
    chatsLoaded: true,
    onQuit: () => {},
    onArchiveChat: () => {},
    onResumeChat: () => {},
  };

  const instance = render(h(RootScreen, props), {
    stdout: fakeStdout as never,
    stdin: new FakeStdin() as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  setTimeout(() => {
    instance.unmount();
    const frame = (frames[frames.length - 1] ?? '').replace(ANSI, '');
    process.stdout.write(
      `\n── preview ${COLS}x${ROWS} · ${PHASE}${DEVICE ? ' · device' : ''} ──\n`
    );
    process.stdout.write(frame);
    process.stdout.write('\n──────────────────────────────────────────\n');
    process.exit(0);
  }, 200);
}

void main();
