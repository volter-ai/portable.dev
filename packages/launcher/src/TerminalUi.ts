import { type DeviceInfo } from '@vgit2/shared/secrets';
import { Box, render, Text, useInput, useStdout, type Instance } from 'ink';
import QRCode from 'qrcode';
import { createElement as h, useEffect, useState } from 'react';

import { type ChatSummary } from './ChatsClient.js';

/**
 * The launcher's steady-state terminal UI (Ink / React), rendered AFTER the api is
 * healthy + the tunnel is up so noisy boot logs never fight Ink for the terminal.
 *
 * ⚠️ **Single Ink instance, re-rendered in place.** There is exactly ONE
 * `render()` for the whole session; transitions (pairing QR → connected menu) go
 * through `instance.rerender(...)`, NOT a second `render()`. Calling `render()` a
 * second time (even after `unmount()`) leaves the previous frame in the scrollback
 * and starts a fresh region BELOW it — the "it printed more content instead of
 * updating" bug. One instance + `rerender` keeps Ink's managed region and redraws
 * it cleanly.
 *
 * The root {@link RootScreen} switches on a `phase` prop:
 *   - `pairing`   → {@link PairingView} (the QR + "waiting for a device").
 *   - `connected` → {@link ConnectedMenuView} (a bordered menu: 1 = add a device,
 *     2 = quit; with an internal sub-view that reveals the QR again).
 *
 * The QR string is pre-rendered (async, {@link renderTerminalQr}) BEFORE the mount
 * so the components stay synchronous. Written with `React.createElement` (aliased
 * `h`) — the launcher tsconfig has no `jsx` setting.
 */

/**
 * Render the payload to a terminal-QR string.
 *
 * Uses qrcode's built-in `{ type: 'terminal', small: true }` HALF-BLOCK render —
 * the same compact, SQUARE render Expo / `qrcode-terminal` use: one module per
 * column and two stacked module-rows per character cell (the `▀▄█`/space glyphs),
 * in the standard 16-color terminal palette (`47m` bg / `30m` fg → the familiar
 * grey QR). Because a terminal cell is ~1:2, stacking two module-rows per cell makes
 * each module render SQUARE and the symbol square overall — which is what a QR
 * scanner needs to lock on.
 *
 * This REPLACED the old hand-rolled SEXTANT (2×3) pack: it halved the width but
 * stretched every module to ~1:1.33 (taller than wide), and phone cameras couldn't
 * decode the distorted modules (the reported "camera opens, never reads"). The cost
 * of square modules is width: the symbol is ~`modules + quiet zone` columns wide
 * (~80 for a JWT payload), so it needs a terminal at least that wide — on a narrower
 * terminal it WRAPS and won't scan, and the loopback SVG pairing page is the
 * reliable fallback. Error correction stays `L` to keep the symbol as small as
 * possible. The QR is intentionally NOT wrapped in a border (a border would widen it
 * past the scan-safe width); the bordered chrome is reserved for the menu.
 */
export async function renderTerminalQr(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'L',
  });
}

/** Humanize an ISO timestamp into a short relative string ("3m ago", "2d ago"). */
export function formatRelativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const sec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'Yesterday';
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}

/** Props shared by every screen (the root re-renders with these + a `phase`). */
export interface RootScreenProps {
  phase: 'booting' | 'pairing' | 'connected';
  /** Updating status line shown in the centered booting box. */
  status?: string;
  /** Pre-rendered terminal-QR string (present once `ready` has run). */
  qr?: string;
  endpoint: string;
  pcId: string;
  label: string;
  loopbackUrl?: string;
  lastConnectedAt?: string;
  /** Live list of currently-connected mobile devices (connected menu, device header). */
  devices?: DeviceInfo[];
  /** Live list of recent chat sessions (connected menu, chats column). */
  chats?: ChatSummary[];
  /** True once the chats have been fetched at least once (distinguishes loading vs empty). */
  chatsLoaded?: boolean;
  /** Archive a chat (the chat-action "Archive" — reversible). */
  onArchiveChat?: (chatId: string) => void;
  /** Resume a chat in Claude Code (stubbed for now). */
  onResumeChat?: (chat: ChatSummary) => void;
  /** Called when the user chooses Quit (or Ctrl-C) on the connected menu. */
  onQuit: () => void;
}

/** The QR + pairing instructions (first run / "add a device"). No hooks. */
function QrPanel(props: {
  qr?: string;
  endpoint: string;
  loopbackUrl?: string;
  /** Footer hint element. */
  footer: ReturnType<typeof h>;
  title: string;
  titleColor: string;
}): ReturnType<typeof h> {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true, color: props.titleColor }, props.title),
    h(Text, {}, ''),
    h(Text, {}, props.qr ?? ''),
    h(Text, {}, ''),
    h(
      Text,
      {},
      'Scan the QR in the Portable app ',
      h(Text, { color: 'gray' }, '(Account → Connect a PC)')
    ),
    h(Text, { color: 'gray' }, `Relay endpoint: ${props.endpoint}`),
    props.loopbackUrl
      ? h(
          Text,
          { color: 'gray' },
          "Can't scan? Open ",
          h(Text, { color: 'cyan' }, props.loopbackUrl),
          ' in a browser.'
        )
      : null,
    h(Text, {}, ''),
    props.footer
  );
}

/** First-run pairing screen: the QR + a "waiting for a device" status. Fills the terminal. */
export function PairingView(props: RootScreenProps): ReturnType<typeof h> {
  const { rows } = useTerminalSize();
  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: rows - 1, paddingX: 1, paddingY: 1 },
    h(Text, { color: 'gray' }, props.label),
    h(Text, {}, ''),
    QrPanel({
      qr: props.qr,
      endpoint: props.endpoint,
      loopbackUrl: props.loopbackUrl,
      title: 'Portable — your PC is live',
      titleColor: 'cyan',
      footer: h(
        Text,
        { color: 'gray' },
        h(Text, { color: 'yellow' }, '◷ '),
        'Waiting for a device to connect… ',
        h(Text, { color: 'gray' }, '(Ctrl-C to stop)')
      ),
    })
  );
}

/**
 * Reactive terminal size — re-renders the screen on resize so the layout always
 * fills the current terminal (we treat the whole terminal as our canvas).
 */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 30,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on('resize', onResize);
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

/** A horizontal rule (section divider) of the given column width. */
function Hr(props: { width: number; color?: string }): ReturnType<typeof h> {
  return h(Text, { color: props.color ?? 'gray' }, '─'.repeat(Math.max(0, props.width)));
}

/** A live HH:MM clock (top-bar, right side). */
function Clock(): ReturnType<typeof h> {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref();
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return h(Text, { color: 'gray' }, `${hh}:${mm}`);
}

/** Truncate a string to `n` cols with an ellipsis. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** Compact device-presence HEADER shown above the chats list (right column). */
function DeviceHeader(props: { devices: DeviceInfo[] }): ReturnType<typeof h> {
  const devices = props.devices;
  if (devices.length === 0) {
    return h(Box, {}, h(Spinner), h(Text, { color: 'gray' }, '  Waiting for mobile device.'));
  }
  const v = devices[0]?.appVersion;
  const label =
    devices.length === 1
      ? `Phone connected${v ? ` · v${v}` : ''}`
      : `${devices.length} devices connected`;
  return h(Text, {}, h(Text, { color: 'green' }, '● '), h(Text, { color: 'green' }, label));
}

const CHAT_TITLE_WIDTH = 46;

/** The repo's short name (`owner/repo` → `repo`). */
function repoShort(full?: string): string {
  return full ? (full.split('/').pop() ?? full) : '';
}

/**
 * The scrollable chats list (right column). Windows `viewport` entries around the
 * selection; each entry is two lines — title (with a leading doc glyph + a
 * RIGHT-ALIGNED relative timestamp) and the repo name dimmed below it.
 */
function ChatList(props: {
  chats: ChatSummary[];
  selected: number;
  focused: boolean;
  viewport: number;
  loaded: boolean;
}): ReturnType<typeof h> {
  const { chats, selected, focused } = props;
  const viewport = Math.max(1, props.viewport);
  if (!props.loaded) {
    return h(Box, {}, h(Spinner), h(Text, { color: 'gray' }, '  Loading chats…'));
  }
  if (chats.length === 0) {
    return h(Text, { color: 'gray' }, 'No recent chats yet.');
  }
  const half = Math.floor(viewport / 2);
  let start = Math.max(0, Math.min(selected - half, chats.length - viewport));
  if (start < 0) start = 0;
  const window = chats.slice(start, start + viewport);

  return h(
    Box,
    { flexDirection: 'column' },
    start > 0 ? h(Text, { color: 'gray' }, `   ↑ ${start} more`) : h(Text, { color: 'gray' }, ''),
    ...window.map((c, i) => {
      const idx = start + i;
      const isSel = focused && idx === selected;
      return h(
        Box,
        { key: c.id, flexDirection: 'column' },
        // Row 1: cursor + glyph + title  …  right-aligned timestamp.
        h(
          Box,
          { width: '100%', justifyContent: 'space-between' },
          h(
            Box,
            {},
            h(Text, { color: isSel ? 'cyan' : 'black' }, isSel ? '❯ ' : '  '),
            h(Text, { color: isSel ? 'cyan' : 'gray' }, '◫ '),
            h(
              Text,
              { color: isSel ? 'whiteBright' : 'white', bold: isSel },
              truncate(c.title, CHAT_TITLE_WIDTH)
            )
          ),
          h(Text, { color: 'gray' }, formatRelativeTime(c.lastUpdated))
        ),
        // Row 2: dim repo name, indented under the title.
        c.repoFullName ? h(Text, { color: 'gray' }, `     ${repoShort(c.repoFullName)}`) : null
      );
    }),
    start + viewport < chats.length
      ? h(Text, { color: 'gray' }, `   ↓ ${chats.length - (start + viewport)} more…`)
      : null
  );
}

/** The chat-action options (Enter on a chat). */
const CHAT_ACTIONS = ['Back', 'Archive', 'Resume in Claude Code'] as const;

/** Bright-ANSI accent for the emphasized brand inside FAQ answers. */
const BRAND_COLOR = 'cyanBright';

/** One run of answer text; `emphasis` runs render in bright ANSI (the brand). */
interface AnswerSegment {
  text: string;
  emphasis?: boolean;
}
/** A single FAQ entry — a question + its answer (as styled segments). */
interface FaqEntry {
  q: string;
  a: AnswerSegment[];
}

/** The Help-screen FAQ. */
const FAQ: FaqEntry[] = [
  {
    q: 'How do I connect to Portable?',
    a: [
      { text: 'Easy, visit the Play Store (Android) or App Store (iPhone) and install the ' },
      { text: 'Portable.dev', emphasis: true },
      { text: ' app.' },
    ],
  },
  {
    q: 'Is Portable.dev private and secure?',
    a: [
      {
        text:
          'Yes, your data stays entirely on your machine. When you connect with your mobile ' +
          "phone, it's connecting to your phone directly through a secure tunnel. That means " +
          'no one can read your data, even our developers. ',
      },
      { text: 'Portable.dev', emphasis: true },
      {
        text:
          ' is open-source and free, and you can inspect this behavior yourself on our ' +
          'GitHub repositories.',
      },
    ],
  },
];

/** Flatten an answer to plain text (for preview truncation / length math). */
function answerPlain(a: AnswerSegment[]): string {
  return a.map((s) => s.text).join('');
}

/** Greedy word-wrap to `width` columns. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur === '') cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ' ' + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The first `maxLines` wrapped lines of `text`; if more remains, the last line ends
 * with an ellipsis to show it's continued.
 */
function previewLines(text: string, width: number, maxLines = 2): string[] {
  const wrapped = wrapText(text, width);
  if (wrapped.length <= maxLines) return wrapped;
  const head = wrapped.slice(0, maxLines);
  const withDots = head[maxLines - 1] + '…';
  head[maxLines - 1] = withDots.length > width ? truncate(head[maxLines - 1], width) : withDots;
  return head;
}

/** Inline answer runs (the emphasized brand in bright ANSI, everything else `baseColor`). */
function answerSegments(a: AnswerSegment[], baseColor: string): ReturnType<typeof h>[] {
  return a.map((s, i) => h(Text, { key: i, color: s.emphasis ? BRAND_COLOR : baseColor }, s.text));
}

/** The top status bar (PORTABLE · ● label →→ <phone> · ● CONNECTED HH:MM) — shared by screens. */
function TopStatusBar(props: {
  phoneConnected: boolean;
  label: string;
  phoneName?: string;
}): ReturnType<typeof h> {
  const phoneColor = props.phoneConnected ? 'green' : 'red';
  // The make/model the phone self-reports (expo-device); else a plain "phone".
  const phoneName = props.phoneName?.trim() || 'phone';
  return h(
    Box,
    { width: '100%', justifyContent: 'space-between' },
    h(Text, { bold: true, color: 'whiteBright' }, 'PORTABLE'),
    // center — <PC name> →→ <phone>. The first arrow is always green (the desktop is
    // always there); the second arrow + phone name are red until a phone connects.
    h(
      Box,
      {},
      h(Text, { color: 'green' }, '● '),
      h(Text, { bold: true, color: 'green' }, props.label),
      h(Text, {}, ' '),
      h(Text, { bold: true, color: 'green' }, '→'),
      h(Text, { bold: true, color: phoneColor }, '→'),
      h(Text, {}, ' '),
      h(Text, { bold: true, color: phoneColor }, phoneName)
    ),
    // right — connection badge + clock
    h(
      Box,
      {},
      h(Text, { color: phoneColor }, `● ${props.phoneConnected ? 'CONNECTED' : 'Disconnected'}`),
      h(Text, {}, '   '),
      h(Clock)
    )
  );
}

/** The bottom context-hint bar (left hints, right quit) — shared by screens. */
function BottomBar(props: { left: string; right: string }): ReturnType<typeof h> {
  return h(
    Box,
    { width: '100%', justifyContent: 'space-between' },
    h(Text, { color: 'gray' }, props.left),
    h(Text, { color: 'gray' }, props.right)
  );
}

/**
 * The scrollable Help/FAQ list (right pane of the Help screen). Each entry shows the
 * question (Q) with its answer (A) beneath. The hovered entry auto-expands to the full
 * styled answer; every other entry shows a two-line preview that ends with an ellipsis
 * when there's more. Q/A are distinguished by colored labels, and the brand inside
 * answers renders in bright ANSI.
 */
function FaqList(props: {
  selected: number;
  focused: boolean;
  width: number;
}): ReturnType<typeof h> {
  const previewWidth = Math.max(20, props.width - 6);
  return h(
    Box,
    { flexDirection: 'column' },
    ...FAQ.map((item, idx) => {
      const isSel = props.focused && idx === props.selected;
      return h(
        Box,
        { key: `faq-${idx}`, flexDirection: 'column', marginBottom: 1 },
        // Question row: cursor + Q label + question text.
        h(
          Text,
          {},
          h(Text, { color: isSel ? 'cyan' : 'gray' }, isSel ? '❯ ' : '  '),
          h(Text, { color: isSel ? BRAND_COLOR : 'cyan', bold: true }, 'Q  '),
          h(Text, { color: isSel ? 'whiteBright' : 'white', bold: isSel }, item.q)
        ),
        // Answer: hovered → full styled answer; otherwise a two-line preview (… if more).
        // Rendered as a [gutter | text] row so the answer text — and EVERY wrapped or
        // continuation line — hang-indents to the same column (5) as the question text
        // above, instead of the expanded text flowing back to the box's left edge.
        h(
          Box,
          { flexDirection: 'row', alignItems: 'flex-start' },
          h(Text, { color: 'green', bold: true }, '  A  '),
          isSel
            ? h(Box, { flexGrow: 1 }, h(Text, {}, ...answerSegments(item.a, 'white')))
            : h(
                Box,
                { flexDirection: 'column' },
                ...previewLines(answerPlain(item.a), previewWidth, 2).map((line, li) =>
                  h(Text, { key: li, color: 'gray' }, line)
                )
              )
        )
      );
    })
  );
}

/**
 * Connected steady-state menu. Inside the green box, THREE columns:
 *   - left:   the menu (status + options 1/2)
 *   - center: a `→ for chats` affordance (press → to move focus to the chats)
 *   - right:  a compact device header above the live, scrollable chats list
 *
 * Focus moves menu ⇄ chats with ←/→; ↑/↓ scroll the chats; Enter opens a chat's
 * action view (Back / Archive / Resume in Claude Code [stub]). `1` still reveals the
 * pairing QR (add a device), `2`/`q`/Ctrl-C quit.
 */
export function ConnectedMenuView(props: RootScreenProps): ReturnType<typeof h> {
  const chats = props.chats ?? [];
  const [mode, setMode] = useState<'menu' | 'qr' | 'action' | 'help'>('menu');
  const [focus, setFocus] = useState<'menu' | 'chats'>('menu');
  const [menuSel, setMenuSel] = useState(0);
  const [chatSel, setChatSel] = useState(0);
  const [actionSel, setActionSel] = useState(0);
  const [actionChat, setActionChat] = useState<ChatSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Help (FAQ) sub-view: which pane is focused (`back` left / `faq` right) and which Q
  // is hovered. The hovered answer auto-expands; everything else shows a 2-line preview.
  const [helpFocus, setHelpFocus] = useState<'back' | 'faq'>('back');
  const [helpSel, setHelpSel] = useState(0);

  // Terminal size is read ONCE here (a hook) so the hook order stays stable across
  // every `mode` branch below — Ink re-renders the SAME component when `mode` changes,
  // so a conditionally-called hook would trip "rendered fewer hooks than last render".
  const { columns, rows } = useTerminalSize();
  const phoneConnected = (props.devices ?? []).length > 0;
  const hrWidth = columns - 2; // minus the outer paddingX

  const clampSel = (i: number) => Math.max(0, Math.min(i, Math.max(0, chats.length - 1)));

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return props.onQuit();

    if (mode === 'qr') {
      if (key.escape || input === 'b') setMode('menu');
      return;
    }

    if (mode === 'action') {
      const run = (sel: number) => {
        if (sel === 0) {
          setMode('menu');
        } else if (sel === 1) {
          if (actionChat) props.onArchiveChat?.(actionChat.id);
          setMode('menu');
        } else if (sel === 2) {
          if (actionChat) props.onResumeChat?.(actionChat);
          setNotice('Resume in Claude Code — coming soon.');
        }
      };
      if (key.upArrow) setActionSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setActionSel((s) => Math.min(CHAT_ACTIONS.length - 1, s + 1));
      else if (key.leftArrow || (input === 'b' && !key.ctrl)) setMode('menu');
      else if (key.return) run(actionSel);
      else if (input === '1') run(0);
      else if (input === '2') run(1);
      else if (input === '3') run(2);
      return;
    }

    if (mode === 'help') {
      const openMenu = () => {
        setMode('menu');
        setHelpFocus('back');
      };
      if (key.escape) return openMenu();
      if (helpFocus === 'back') {
        if (key.rightArrow) setHelpFocus('faq');
        else if (key.return || key.leftArrow || (input === 'b' && !key.ctrl)) openMenu();
        return;
      }
      // helpFocus === 'faq' — ↑/↓ browse (the hovered answer auto-expands), ←/b back.
      if (key.leftArrow || (input === 'b' && !key.ctrl)) setHelpFocus('back');
      else if (key.upArrow) setHelpSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setHelpSel((s) => Math.min(FAQ.length - 1, s + 1));
      return;
    }

    // mode === 'menu'
    if (focus === 'menu') {
      const openHelp = () => {
        setMode('help');
        setHelpFocus('back');
        setHelpSel(0);
      };
      if (input === '1') setMode('qr');
      else if (input === '2') openHelp();
      else if (input === '3' || input === 'q') props.onQuit();
      else if (key.upArrow) setMenuSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setMenuSel((s) => Math.min(2, s + 1));
      else if (key.return) {
        if (menuSel === 0) setMode('qr');
        else if (menuSel === 1) openHelp();
        else props.onQuit();
      } else if (key.rightArrow && chats.length > 0) {
        setChatSel((s) => clampSel(s));
        setFocus('chats');
      }
      return;
    }
    // focus === 'chats'
    if (key.leftArrow || input === 'b') setFocus('menu');
    else if (key.upArrow) setChatSel((s) => clampSel(s - 1));
    else if (key.downArrow) setChatSel((s) => clampSel(s + 1));
    else if (key.return && chats[clampSel(chatSel)]) {
      setActionChat(chats[clampSel(chatSel)]);
      setActionSel(0);
      setNotice(null);
      setMode('action');
    }
  });

  // ── add-a-device QR sub-view ───────────────────────────────────────────────
  if (mode === 'qr') {
    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      QrPanel({
        qr: props.qr,
        endpoint: props.endpoint,
        loopbackUrl: props.loopbackUrl,
        title: 'Connect a new device',
        titleColor: 'cyan',
        footer: h(
          Text,
          { color: 'gray' },
          'Press ',
          h(Text, { color: 'cyan', bold: true }, 'b'),
          ' to go back · ',
          h(Text, { color: 'cyan', bold: true }, 'Ctrl-C'),
          ' to stop'
        ),
      })
    );
  }

  // ── chat-action sub-view (Enter on a chat) ─────────────────────────────────
  if (mode === 'action' && actionChat) {
    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'green', paddingX: 1 },
      h(Text, { bold: true, color: 'green' }, 'Chat'),
      h(Text, { color: 'white' }, truncate(actionChat.title, 60)),
      actionChat.repoFullName ? h(Text, { color: 'gray' }, actionChat.repoFullName) : null,
      h(Text, {}, ''),
      ...CHAT_ACTIONS.map((label, i) => {
        const isSel = i === actionSel;
        return h(
          Text,
          { key: label },
          h(Text, { color: isSel ? 'cyan' : 'gray' }, isSel ? '❯ ' : '  '),
          h(Text, { color: 'cyan', bold: true }, `[${i + 1}] `),
          h(Text, { color: isSel ? 'white' : 'gray', bold: isSel }, label)
        );
      }),
      notice ? h(Text, {}, '') : null,
      notice ? h(Text, { color: 'yellow' }, notice) : null,
      h(Text, {}, ''),
      h(Text, { color: 'gray' }, '↑/↓ select · Enter · b back')
    );
  }

  // ── Help / FAQ sub-view — preserves the chrome; swaps the panes (left = Back,
  //    right = a scrollable FAQ with expandable answers). ────────────────────────
  if (mode === 'help') {
    const onFaq = helpFocus === 'faq';
    const backSel = helpFocus === 'back';
    const faqWidth = Math.max(24, columns - 44);
    return h(
      Box,
      { flexDirection: 'column', width: '100%', height: rows - 1, paddingX: 1 },
      TopStatusBar({
        phoneConnected,
        label: props.label,
        phoneName: (props.devices ?? [])[0]?.name,
      }),
      h(Hr, { width: hrWidth }),
      h(
        Box,
        { width: '100%', flexGrow: 1, marginY: 1, flexDirection: 'row' },
        // Left rail — just Back.
        h(
          Box,
          { flexDirection: 'column', width: 36 },
          h(Text, { bold: true, color: onFaq ? 'gray' : 'cyan' }, 'Help'),
          h(Text, {}, ''),
          h(
            Box,
            {
              flexDirection: 'column',
              borderStyle: 'round',
              borderColor: onFaq ? 'gray' : 'cyan',
              paddingX: 1,
            },
            h(
              Text,
              {},
              h(Text, { color: backSel ? 'cyan' : 'black' }, backSel ? '› ' : '  '),
              h(Text, { color: onFaq ? 'gray' : 'cyan', bold: true }, '[b] '),
              h(Text, { color: backSel ? 'whiteBright' : 'gray', bold: backSel }, 'Back')
            )
          )
        ),
        // Vertical rule (stretches to the body height).
        h(Box, {
          borderStyle: 'single',
          borderColor: 'gray',
          borderLeft: true,
          borderTop: false,
          borderRight: false,
          borderBottom: false,
          marginX: 2,
        }),
        // Right — the FAQ.
        h(
          Box,
          { flexDirection: 'column', flexGrow: 1 },
          h(
            Box,
            { width: '100%', justifyContent: 'center' },
            h(
              Text,
              { bold: true, color: onFaq ? 'cyanBright' : 'gray' },
              'Frequently Asked Questions'
            )
          ),
          h(Box, { height: 1 }),
          FaqList({ selected: helpSel, focused: onFaq, width: faqWidth })
        )
      ),
      h(Hr, { width: hrWidth }),
      BottomBar({
        left: onFaq ? '↑/↓ browse   ← back' : '→ to browse the FAQ   Enter/← back to menu',
        right: 'Ctrl-C  quit',
      })
    );
  }

  // ── main connected screen — fills the whole terminal, reflows on resize ──────
  const onChats = focus === 'chats';
  // Chat rows that fit: each entry is 2 lines; leave slack for chrome so the body
  // never overflows the screen (which would scroll). Conservative on purpose.
  const chatViewport = Math.max(3, Math.floor((rows - 15) / 2));

  const menuRow = (
    i: number,
    keyLabel: string,
    label: string,
    sublabel?: string
  ): ReturnType<typeof h> => {
    const isSel = focus === 'menu' && menuSel === i;
    const row = h(
      Text,
      {},
      h(Text, { color: isSel ? 'cyan' : 'black' }, isSel ? '› ' : '  '),
      h(Text, { color: onChats ? 'gray' : 'cyan', bold: true }, `${keyLabel} `),
      h(Text, { color: isSel ? 'whiteBright' : 'gray', bold: isSel }, label)
    );
    if (!sublabel) return row;
    // A second, hanging-indented line aligned under the title (cursor + keyLabel + space).
    const indent = ' '.repeat(2 + keyLabel.length + 1);
    return h(
      Box,
      { flexDirection: 'column' },
      row,
      h(Text, { color: isSel ? 'whiteBright' : 'gray', bold: isSel }, `${indent}${sublabel}`)
    );
  };

  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: rows - 1, paddingX: 1 },
    // ── top status bar: PORTABLE · ● label ◀──▶ Phone · ● CONNECTED/Disconnected HH:MM ──
    TopStatusBar({ phoneConnected, label: props.label, phoneName: (props.devices ?? [])[0]?.name }),
    h(Hr, { width: hrWidth }),
    // ── main two-column body (grows to fill), split by a vertical rule ──
    h(
      Box,
      { width: '100%', flexGrow: 1, marginY: 1, flexDirection: 'row' },
      // Left bar — just the menu (the PC name now lives in the top bar). "→ for chats"
      // is in the footer; the machine id is never shown (meaningless to a user).
      h(
        Box,
        { flexDirection: 'column', width: 28 },
        h(Text, { color: 'gray' }, `Last connected: ${formatRelativeTime(props.lastConnectedAt)}`),
        h(Text, {}, ''),
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'round',
            borderColor: onChats ? 'gray' : 'cyan',
            paddingX: 1,
          },
          menuRow(0, '[1]', 'Pair Device', '(QR Code)'),
          menuRow(1, '[2]', 'Help'),
          menuRow(2, '[3]', 'Quit')
        )
      ),
      // Vertical rule (stretches to the body height).
      h(Box, {
        borderStyle: 'single',
        borderColor: 'gray',
        borderLeft: true,
        borderTop: false,
        borderRight: false,
        borderBottom: false,
        marginX: 2,
      }),
      // Right — device header above the live, scrollable chats list.
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        // Device status, centered above the chats, with a blank line below it.
        // (An explicit-height spacer — an empty <Text> collapses to 0 rows here.)
        h(
          Box,
          { width: '100%', justifyContent: 'center' },
          DeviceHeader({ devices: props.devices ?? [] })
        ),
        h(Box, { height: 1 }),
        h(Text, { bold: true, color: onChats ? 'cyan' : 'gray' }, 'Recent chats'),
        h(Box, { height: 1 }),
        ChatList({
          chats,
          selected: chatSel,
          focused: onChats,
          viewport: chatViewport,
          loaded: props.chatsLoaded ?? false,
        })
      )
    ),
    h(Hr, { width: hrWidth }),
    // ── bottom bar (context hints) ──
    BottomBar({
      left: onChats
        ? '↑/↓ scroll   Enter select   ← back'
        : '↑/↓ select   Enter open   → for chats',
      right: 'Ctrl-C  quit',
    })
  );
}

/** A braille dot spinner that animates on its own timer (Ink re-renders on tick). */
function Spinner(): ReturnType<typeof h> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref();
    return () => clearInterval(t);
  }, []);
  return h(Text, { color: 'cyan' }, frames[frame % frames.length]);
}

/**
 * The BOOTING screen: a centered, bordered box whose status line UPDATES in place
 * as the runtime comes up (api → health → token → tunnel → pairing), so the boot
 * sequence reads as live status text instead of scrolling logs.
 */
export function BootingView(props: RootScreenProps): ReturnType<typeof h> {
  const { rows } = useTerminalSize();
  return h(
    Box,
    {
      width: '100%',
      height: rows - 1,
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    },
    h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'cyan',
        paddingX: 2,
        paddingY: 1,
        alignItems: 'center',
      },
      h(Text, { bold: true, color: 'cyan' }, 'Portable'),
      h(Text, { color: 'gray' }, props.label),
      h(Text, {}, ''),
      h(Box, {}, h(Spinner), h(Text, {}, `  ${props.status ?? 'Starting…'}`))
    )
  );
}

/**
 * Root screen — switches on `phase`. The single Ink tree re-renders this in place.
 *
 * ⚠️ Each view is rendered as a CHILD COMPONENT (`h(View, props)`), NOT called
 * directly (`View(props)`). The views use hooks (`ConnectedMenuView`'s
 * useState/useInput, `Spinner`'s useEffect); inlining them would make RootScreen's
 * hook count change across a phase switch → "rendered more hooks than last render".
 * As children, React mounts/unmounts each with its own consistent hook order.
 */
export function RootScreen(props: RootScreenProps): ReturnType<typeof h> {
  if (props.phase === 'booting') return h(BootingView, props);
  if (props.phase === 'connected') return h(ConnectedMenuView, props);
  return h(PairingView, props);
}

/** Options passed to `ready()` — the booting → steady-state transition. */
export interface ReadyOptions {
  /** The pre-rendered terminal QR string. */
  qr: string;
  /** The steady-state screen to show (`connected` if a device has paired before). */
  phase: 'pairing' | 'connected';
  loopbackUrl?: string;
  lastConnectedAt?: string;
}

/**
 * A started terminal UI — a SINGLE Ink instance driven through its lifecycle via
 * `rerender` (never a second `render()`):
 *   - `setStatus(text)` updates the booting box's status line in place.
 *   - `ready(opts)` switches from booting to the steady screen (QR or menu).
 *   - `showConnected(state)` swaps the live QR → connected menu when a device joins.
 */
export interface LauncherUiHandle {
  /** Update the booting status line (in place). No-op once `ready`/stopped. */
  setStatus: (status: string) => void;
  /** Transition from the booting box to the steady-state screen. */
  ready: (opts: ReadyOptions) => void;
  /** Swap the live QR for the connected menu IN PLACE (device joined). */
  showConnected: (state: { lastConnectedAt?: string }) => void;
  /** Update the connected menu's live device header (in place). */
  setDevices: (devices: DeviceInfo[]) => void;
  /** Update the connected menu's live chats list (in place). */
  setChats: (chats: ChatSummary[]) => void;
  /** Unmount the Ink app (restores the terminal). Idempotent. */
  stop: () => void;
}

export interface StartLauncherUiOptions {
  endpoint: string;
  pcId: string;
  label: string;
  loopbackUrl?: string;
  /** Which screen to mount first — normally `booting`. */
  initialPhase: 'booting' | 'pairing' | 'connected';
  /** Initial booting status line. */
  status?: string;
  /** Pre-rendered QR (only when mounting straight into pairing/connected, e.g. tests). */
  qr?: string;
  lastConnectedAt?: string;
  /** Called when the user chooses Quit / Ctrl-C on the menu. */
  onQuit: () => void;
  /** Archive a chat (chat-action "Archive"). */
  onArchiveChat?: (chatId: string) => void;
  /** Resume a chat in Claude Code (stub). */
  onResumeChat?: (chat: ChatSummary) => void;
  /** Ink render seam (tests inject a fake returning an {@link Instance}). */
  renderImpl?: typeof render;
}

/**
 * Mount the root screen ONCE (normally on the booting box) and return a handle that
 * drives it through `setStatus` → `ready` → `showConnected`, each a `rerender` of
 * the SAME instance. `stop()` unmounts it (idempotent).
 */
export async function startLauncherUi(options: StartLauncherUiOptions): Promise<LauncherUiHandle> {
  const renderImpl = options.renderImpl ?? render;

  let phase: RootScreenProps['phase'] = options.initialPhase;
  let status = options.status;
  let qr = options.qr;
  let loopbackUrl = options.loopbackUrl;
  let lastConnectedAt = options.lastConnectedAt;
  let devices: DeviceInfo[] = [];
  let chats: ChatSummary[] = [];
  let chatsLoaded = false;

  const build = (): ReturnType<typeof h> =>
    h(RootScreen, {
      phase,
      status,
      qr,
      endpoint: options.endpoint,
      pcId: options.pcId,
      label: options.label,
      loopbackUrl,
      lastConnectedAt,
      devices,
      chats,
      chatsLoaded,
      onArchiveChat: options.onArchiveChat,
      onResumeChat: options.onResumeChat,
      onQuit: options.onQuit,
    });

  let instance: Instance | null = renderImpl(build());
  const rerender = () => {
    if (!instance) return;
    try {
      instance.rerender(build());
    } catch {
      // non-interactive / already torn down — ignore.
    }
  };

  return {
    setStatus: (next) => {
      status = next;
      rerender();
    },
    ready: (opts) => {
      qr = opts.qr;
      phase = opts.phase;
      if (opts.loopbackUrl !== undefined) loopbackUrl = opts.loopbackUrl;
      if (opts.lastConnectedAt !== undefined) lastConnectedAt = opts.lastConnectedAt;
      rerender();
    },
    showConnected: (state) => {
      phase = 'connected';
      lastConnectedAt = state.lastConnectedAt ?? lastConnectedAt;
      rerender();
    },
    setDevices: (next) => {
      devices = next;
      rerender();
    },
    setChats: (next) => {
      chats = next;
      chatsLoaded = true; // first call flips loading → loaded (even if empty)
      rerender();
    },
    stop: () => {
      if (!instance) return;
      try {
        instance.unmount();
      } catch {
        // already unmounted / non-TTY — ignore.
      }
      instance = null;
    },
  };
}

/**
 * `--debug` mode: a plain-text {@link LauncherUiHandle} (NO live Ink — a live region
 * would clobber the api logs streamed to the same terminal in debug). `setStatus`
 * logs each boot step, `ready` prints the QR block once, `showConnected` logs a
 * one-liner, `stop` is a no-op.
 */
export async function startStaticUi(
  options: StartLauncherUiOptions & { log?: (line: string) => void }
): Promise<LauncherUiHandle> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (options.status) log(`[launcher] ${options.status}`);

  return {
    setStatus: (next) => log(`[launcher] ${next}`),
    ready: (opts) => {
      const lines: string[] = [
        '',
        'Portable — your PC is live',
        `${options.label} · ${options.pcId}`,
        '',
        opts.qr,
        '',
        'Scan the QR in the Portable app (Account → Connect a PC)',
        `Relay endpoint: ${options.endpoint}`,
        ...(opts.loopbackUrl
          ? [`Can't scan the QR above? Open ${opts.loopbackUrl} in a browser.`]
          : []),
        '',
        '[debug] streaming api logs below — press Ctrl-C to stop.',
        '',
      ];
      for (const line of lines) log(line);
    },
    showConnected: () => log('[launcher] a device connected.'),
    setDevices: (devices) =>
      log(
        devices.length === 0
          ? '[launcher] no mobile device connected.'
          : `[launcher] ${devices.length} mobile device(s) connected.`
      ),
    setChats: () => {}, // debug mode: chats UI is not interactive
    stop: () => {},
  };
}
