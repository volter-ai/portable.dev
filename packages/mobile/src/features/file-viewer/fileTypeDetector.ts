/**
 * fileTypeDetector — native file-type detection for the viewers.
 *
 * Framework-free (no JSX, no RN imports) so it is unit-testable and reusable by
 * the viewer dispatch + the breadcrumb. Extension maps
 * and special cases (`.env`, README/Dockerfile-style basenames) so the
 * RN file viewers select a consistent viewer for any given filename.
 */

export type FileType =
  | 'markdown'
  | 'code'
  | 'csv'
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'text'
  | 'binary';

export interface FileTypeInfo {
  type: FileType;
  /** Syntax-highlight language hint for `code`/`text` files. */
  language?: string;
  canEdit?: boolean;
  canPreview: boolean;
}

/** The file types whose bytes are streamed directly (no text decode). */
export const BINARY_PREVIEW_TYPES: ReadonlySet<FileType> = new Set<FileType>([
  'image',
  'pdf',
  'video',
  'audio',
]);

/** Language mappings for syntax highlighting (extension → language id). */
const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mjs: 'javascript',
  cjs: 'javascript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  env: 'bash',
  py: 'python',
  pyw: 'python',
  pyx: 'python',
  rb: 'ruby',
  rake: 'ruby',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  java: 'java',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  dockerfile: 'dockerfile',
  r: 'r',
  lua: 'lua',
  perl: 'perl',
  pl: 'perl',
};

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
  'tiff',
  'tif',
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov', 'avi', 'wmv', 'flv', 'mkv', 'm4v']);

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'opus']);

const CSV_EXTENSIONS = new Set(['csv', 'tsv']);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'log',
  'ini',
  'cfg',
  'conf',
  'properties',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'eslintrc',
  'prettierrc',
  'nvmrc',
  'npmrc',
  'yarnrc',
  'license',
  'authors',
  'contributors',
  'changelog',
  'readme',
  'makefile',
  'cmake',
  'gradle',
]);

/** Detect the file type + viewer hints from a filename. */
export function detectFileType(filename: string): FileTypeInfo {
  const ext = getFileExtension(filename).toLowerCase();
  const basename = filename.toLowerCase();

  // `.env` / `.env.*` have no extension after the dot — treat as text.
  const filenameOnly = filename.split('/').pop() || filename;
  if (filenameOnly === '.env' || filenameOnly.startsWith('.env.')) {
    return { type: 'text', language: 'bash', canEdit: true, canPreview: true };
  }

  if (ext === 'md' || ext === 'markdown') {
    return { type: 'markdown', language: 'markdown', canEdit: true, canPreview: true };
  }
  if (ext === 'pdf') {
    return { type: 'pdf', canEdit: false, canPreview: true };
  }
  if (CSV_EXTENSIONS.has(ext)) {
    return { type: 'csv', canEdit: true, canPreview: true };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { type: 'image', canEdit: false, canPreview: true };
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { type: 'video', canEdit: false, canPreview: true };
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { type: 'audio', canEdit: false, canPreview: true };
  }
  if (LANGUAGE_MAP[ext]) {
    return { type: 'code', language: LANGUAGE_MAP[ext], canEdit: true, canPreview: true };
  }
  if (TEXT_EXTENSIONS.has(ext) || isLikelyTextFile(basename)) {
    return { type: 'text', canEdit: true, canPreview: true };
  }
  return { type: 'binary', canEdit: false, canPreview: false };
}

/** True for image/pdf/video/audio — fetched via the raw byte endpoint. */
export function isBinaryPreview(type: FileType): boolean {
  return BINARY_PREVIEW_TYPES.has(type);
}

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) return '';
  return filename.slice(lastDot + 1);
}

function isLikelyTextFile(basename: string): boolean {
  const textFilePatterns = [
    'readme',
    'license',
    'authors',
    'contributors',
    'changelog',
    'makefile',
    'dockerfile',
    'gemfile',
    'rakefile',
    'procfile',
    'vagrantfile',
    'berksfile',
    'guardfile',
    'capfile',
  ];
  return textFilePatterns.some((pattern) => basename.includes(pattern));
}
