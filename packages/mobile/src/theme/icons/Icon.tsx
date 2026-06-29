/**
 * `Icon` — the app's line-icon set, drawn with `react-native-svg` primitives.
 *
 * FontAwesome/`@expo/vector-icons` are NOT bundled (CLAUDE.md rule — they would be a
 * new dependency + glyph fonts). These are simple, hand-authored geometric shapes on
 * a 24×24 grid (stroke style, round caps) — clean, themeable, and IP-free. The whale
 * brand mark lives in {@link WhaleIcon} (a port of the project's own SVG).
 *
 * Each renderer returns its own `<Svg>` with INLINE primitive children: the React 18
 * type tree clerk-expo pulls in rejects a pre-computed `ReactNode`/`ReactElement`
 * variable in the `<Svg>` children slot (the 18/19 `bigint`/`ReactPortal` mismatch),
 * but inline literal children check fine.
 */

import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';

export type IconName =
  | 'comments'
  | 'code-branch'
  | 'mobile-screen'
  | 'gear'
  | 'paper-plane'
  | 'microphone'
  | 'paperclip'
  | 'plus'
  | 'search'
  | 'filter'
  | 'chevron-right'
  | 'chevron-down'
  | 'xmark'
  | 'archive'
  | 'refresh'
  | 'user'
  | 'warning'
  | 'bars'
  | 'ellipsis'
  | 'bolt'
  | 'download'
  | 'copy'
  | 'pause'
  | 'arrow-up'
  | 'arrow-down'
  | 'folder'
  | 'shield'
  | 'chevron-up'
  | 'chevron-left'
  | 'rocket'
  | 'stop'
  | 'square-check'
  | 'globe'
  | 'terminal'
  | 'trash'
  | 'hard-drive'
  | 'desktop'
  | 'list'
  | 'grid'
  | 'circle'
  | 'circle-dot'
  | 'circle-slash'
  | 'check'
  | 'play'
  | 'power'
  | 'file'
  | 'pin'
  | 'bookmark'
  | 'github';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

type Renderer = (c: string, sw: number, size: number) => React.ReactElement;

const svg = (size: number, children: React.ReactElement) => (
  // `as never` bridges the React 18 (clerk-expo) ↔ 19 ReactNode/ReactPortal mismatch
  // for a pre-computed children variable in the <Svg> slot (inline literals are fine,
  // but the dynamic `RENDERERS[name]()` indirection needs this one localized cast).
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {children as never}
  </Svg>
);

const RENDERERS: Record<IconName, Renderer> = {
  comments: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M21 11.5a8 8 0 0 1-8.5 8 9 9 0 0 1-3.8-.85L3 20.5l1.9-4.2A8 8 0 0 1 4 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8.5 8z"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  'code-branch': (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={6} y1={4} x2={6} y2={15} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Circle cx={6} cy={18} r={2.5} stroke={c} strokeWidth={sw} fill="none" />
        <Circle cx={6} cy={4} r={2.5} stroke={c} strokeWidth={sw} fill="none" />
        <Circle cx={18} cy={7} r={2.5} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M18 9.5v1A4.5 4.5 0 0 1 13.5 15H10"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  'mobile-screen': (c, sw, size) =>
    svg(
      size,
      <>
        <Rect
          x={7}
          y={2.5}
          width={10}
          height={19}
          rx={2.5}
          stroke={c}
          strokeWidth={sw}
          fill="none"
        />
        <Line
          x1={10.5}
          y1={18.5}
          x2={13.5}
          y2={18.5}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  // A real cog: a toothed outer ring (8 trapezoidal teeth) + a center hole.
  gear: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M10.4 2.6h3.2l.5 2.3a7 7 0 0 1 1.95.8l2-1.2 2.25 2.25-1.2 2a7 7 0 0 1 .8 1.95l2.3.5v3.2l-2.3.5a7 7 0 0 1-.8 1.95l1.2 2-2.25 2.25-2-1.2a7 7 0 0 1-1.95.8l-.5 2.3h-3.2l-.5-2.3a7 7 0 0 1-1.95-.8l-2 1.2-2.25-2.25 1.2-2a7 7 0 0 1-.8-1.95l-2.3-.5v-3.2l2.3-.5a7 7 0 0 1 .8-1.95l-1.2-2 2.25-2.25 2 1.2a7 7 0 0 1 1.95-.8z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinejoin="round"
        />
        <Circle cx={12} cy={12} r={3} stroke={c} strokeWidth={sw} fill="none" />
      </>
    ),
  'paper-plane': (c, sw, size) =>
    svg(
      size,
      <>
        <Line
          x1={21}
          y1={3}
          x2={10.5}
          y2={13.5}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M21 3l-6.5 18-4-8-8-4z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  microphone: (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={9} y={2.5} width={6} height={11} rx={3} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M5.5 11v.5a6.5 6.5 0 0 0 13 0V11"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
        />
        <Line x1={12} y1={18} x2={12} y2={21.5} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line
          x1={8.5}
          y1={21.5}
          x2={15.5}
          y2={21.5}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  paperclip: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M20 11.5l-8.4 8.4a5 5 0 0 1-7-7l8.4-8.4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.4a1.7 1.7 0 0 1-2.3-2.3l7.8-7.8"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  plus: (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={12} y1={5} x2={12} y2={19} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={5} y1={12} x2={19} y2={12} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  search: (c, sw, size) =>
    svg(
      size,
      <>
        <Circle cx={11} cy={11} r={7} stroke={c} strokeWidth={sw} fill="none" />
        <Line
          x1={16.2}
          y1={16.2}
          x2={21}
          y2={21}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  filter: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M3 5h18l-7 8v5.5l-4 2.5V13L3 5z"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  'chevron-right': (c, sw, size) =>
    svg(
      size,
      <Polyline
        points="9 5 16 12 9 19"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  'chevron-down': (c, sw, size) =>
    svg(
      size,
      <Polyline
        points="5 9 12 16 19 9"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  xmark: (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={6} y1={6} x2={18} y2={18} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={18} y1={6} x2={6} y2={18} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  archive: (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={3} y={4} width={18} height={4} rx={1} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line
          x1={9.5}
          y1={12}
          x2={14.5}
          y2={12}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  refresh: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M20.5 12a8.5 8.5 0 1 1-2.5-6"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Polyline
          points="20.5 3 20.5 8.5 15 8.5"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  user: (c, sw, size) =>
    svg(
      size,
      <>
        <Circle cx={12} cy={8} r={4} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M4 21a8 8 0 0 1 16 0"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
        />
      </>
    ),
  warning: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M12 3.5l9.5 16.5H2.5z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line x1={12} y1={10} x2={12} y2={14.5} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={12} y1={17} x2={12} y2={17} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  bars: (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={4} y1={7} x2={20} y2={7} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={4} y1={12} x2={20} y2={12} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={4} y1={17} x2={20} y2={17} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  ellipsis: (c, _sw, size) =>
    svg(
      size,
      <>
        <Circle cx={5} cy={12} r={1.7} fill={c} />
        <Circle cx={12} cy={12} r={1.7} fill={c} />
        <Circle cx={19} cy={12} r={1.7} fill={c} />
      </>
    ),
  bolt: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M13 2.5L4.5 13.5H11l-1 8L19.5 10H12z"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  download: (c, sw, size) =>
    svg(
      size,
      <>
        <Line
          x1={12}
          y1={3.5}
          x2={12}
          y2={14.5}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
        <Polyline
          points="7.5 10 12 14.5 16.5 10"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  'arrow-up': (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={12} y1={19} x2={12} y2={5} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Polyline
          points="6 11 12 5 18 11"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  'arrow-down': (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={12} y1={5} x2={12} y2={19} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Polyline
          points="6 13 12 19 18 13"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  folder: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  shield: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M12 3l7 3v5.5c0 4.3-3 7.3-7 8.5-4-1.2-7-4.2-7-8.5V6z"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  'chevron-up': (c, sw, size) =>
    svg(
      size,
      <Polyline
        points="5 15 12 8 19 15"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  'chevron-left': (c, sw, size) =>
    svg(
      size,
      <Polyline
        points="15 5 8 12 15 19"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  stop: (c, _sw, size) => svg(size, <Rect x={6} y={6} width={12} height={12} rx={2.5} fill={c} />),
  'square-check': (c, sw, size) =>
    svg(
      size,
      <>
        <Rect
          x={3.5}
          y={3.5}
          width={17}
          height={17}
          rx={3}
          stroke={c}
          strokeWidth={sw}
          fill="none"
        />
        <Polyline
          points="8 12.5 11 15.5 16.5 9"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  rocket: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M12 2.5c2.8 2 4.2 5 4.2 8l-4.2 3-4.2-3c0-3 1.4-6 4.2-8z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinejoin="round"
        />
        <Circle cx={12} cy={8.5} r={1.4} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M9.8 14l-2 4 2.2-1 2 1.5 2-1.5 2.2 1-2-4"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  globe: (c, sw, size) =>
    svg(
      size,
      <>
        <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={sw} fill="none" />
        <Line x1={3} y1={12} x2={21} y2={12} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Path
          d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  terminal: (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={3} y={4} width={18} height={16} rx={2} stroke={c} strokeWidth={sw} fill="none" />
        <Polyline
          points="7 9 10 12 7 15"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line
          x1={12.5}
          y1={15}
          x2={16.5}
          y2={15}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  trash: (c, sw, size) =>
    svg(
      size,
      <>
        <Polyline
          points="4 6 20 6"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M18 6v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  'hard-drive': (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={3} y={13} width={18} height={7} rx={2} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M5.5 13l2.2-7.2A2 2 0 0 1 9.6 4.5h4.8a2 2 0 0 1 1.9 1.3L18.5 13"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line
          x1={16.5}
          y1={16.5}
          x2={16.51}
          y2={16.5}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  desktop: (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={3} y={4} width={18} height={12} rx={2} stroke={c} strokeWidth={sw} fill="none" />
        <Line x1={9} y1={20} x2={15} y2={20} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={12} y1={16} x2={12} y2={20} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  list: (c, sw, size) =>
    svg(
      size,
      <>
        <Line x1={8} y1={6} x2={20} y2={6} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={8} y1={12} x2={20} y2={12} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={8} y1={18} x2={20} y2={18} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={4} y1={6} x2={4.01} y2={6} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={4} y1={12} x2={4.01} y2={12} stroke={c} strokeWidth={sw} strokeLinecap="round" />
        <Line x1={4} y1={18} x2={4.01} y2={18} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  grid: (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={3} y={3} width={7} height={7} rx={1.5} stroke={c} strokeWidth={sw} fill="none" />
        <Rect x={14} y={3} width={7} height={7} rx={1.5} stroke={c} strokeWidth={sw} fill="none" />
        <Rect x={3} y={14} width={7} height={7} rx={1.5} stroke={c} strokeWidth={sw} fill="none" />
        <Rect x={14} y={14} width={7} height={7} rx={1.5} stroke={c} strokeWidth={sw} fill="none" />
      </>
    ),
  circle: (c, _sw, size) => svg(size, <Circle cx={12} cy={12} r={6} fill={c} />),
  // GitHub "issue-opened" octicon: an outer ring with a filled center dot.
  'circle-dot': (c, sw, size) =>
    svg(
      size,
      <>
        <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={sw} fill="none" />
        <Circle cx={12} cy={12} r={3} fill={c} />
      </>
    ),
  // A circle with a diagonal line through it — the "cancel / abort" sign. Used for the
  // chat-interrupt Stop so it doesn't read as a (square) stop-RECORDING button now that
  // voice dictation lives in the composer.
  'circle-slash': (c, sw, size) =>
    svg(
      size,
      <>
        <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={sw} fill="none" />
        <Line
          x1={5.6}
          y1={5.6}
          x2={18.4}
          y2={18.4}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  check: (c, sw, size) =>
    svg(
      size,
      <Polyline
        points="5 13 10 18 19 6"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  play: (c, _sw, size) => svg(size, <Path d="M7 5l11 7-11 7z" fill={c} />),
  pause: (c, _sw, size) =>
    svg(
      size,
      <>
        <Rect x={6.5} y={5} width={3.5} height={14} rx={1} fill={c} />
        <Rect x={14} y={5} width={3.5} height={14} rx={1} fill={c} />
      </>
    ),
  copy: (c, sw, size) =>
    svg(
      size,
      <>
        <Rect x={9} y={9} width={11} height={11} rx={2} stroke={c} strokeWidth={sw} fill="none" />
        <Path
          d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  file: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Polyline
          points="13 3 13 9 19 9"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  // Thumbtack — the "pinned to top" mark (a trapezoidal head + a needle).
  pin: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M9.5 3.5h5l-.7 5.2 2.7 2.3v1.3H7.5v-1.3l2.7-2.3z"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line
          x1={12}
          y1={12.3}
          x2={12}
          y2={20.5}
          stroke={c}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    ),
  // Bookmark — the "Save for later" mark.
  bookmark: (c, sw, size) =>
    svg(
      size,
      <Path
        d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4z"
        stroke={c}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  // Standard power symbol: a top-open arc + a vertical line through the gap.
  power: (c, sw, size) =>
    svg(
      size,
      <>
        <Path
          d="M7.5 6.3A8 8 0 1 0 16.5 6.3"
          stroke={c}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line x1={12} y1={3} x2={12} y2={12} stroke={c} strokeWidth={sw} strokeLinecap="round" />
      </>
    ),
  // GitHub mark (filled silhouette) — used for the "view it on GitHub" link.
  github: (c, _sw, size) =>
    svg(
      size,
      <Path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill={c}
      />
    ),
};

export function Icon({ name, size = 24, color = '#000000', strokeWidth = 2 }: IconProps) {
  return RENDERERS[name](color, strokeWidth, size);
}
