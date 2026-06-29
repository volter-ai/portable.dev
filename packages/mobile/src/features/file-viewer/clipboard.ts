/**
 * copyToClipboard — write text to the system clipboard.
 *
 * The ONLY importer of `expo-clipboard`, loaded via a LAZY `require` inside the
 * function (the `deviceSse.ts` pattern) so importing a file viewer
 * never pulls the native clipboard module into the Jest / Metro module graph —
 * only an actual copy touches it. Components take an injectable `onCopy` seam
 * (defaulting to this) so their tests never load the native module.
 */
export async function copyToClipboard(text: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Clipboard = require('expo-clipboard') as {
    setStringAsync: (value: string) => Promise<boolean>;
  };
  await Clipboard.setStringAsync(text);
}
