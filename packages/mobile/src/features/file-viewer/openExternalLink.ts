/**
 * openExternalLink — open a URL in the SYSTEM browser.
 *
 * A binary file the
 * viewers can't preview is downloaded by opening its authenticated `/raw/` URL in
 * the OS browser (SFSafariViewController on iOS / Chrome Custom Tab on Android) —
 * NEVER an embedded WebView and NEVER `expo-file-system` (the iOS arbitrary-web-
 * content rule). `expo-web-browser` is loaded
 * via a LAZY `require` inside the function (the `runtime/SandboxWebView`
 * `openSandboxUrlExternal` pattern) so importing a viewer never pulls the native
 * module into the Jest / Metro graph; the consumer injects this as a seam for tests.
 */
export function openExternalLink(url: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WebBrowser = require('expo-web-browser') as {
    openBrowserAsync: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  void WebBrowser.openBrowserAsync(url, { presentationStyle: 'fullScreen' });
}
