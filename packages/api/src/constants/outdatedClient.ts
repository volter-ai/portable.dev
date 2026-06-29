/**
 * Outdated-client notice
 *
 * A native React Native build that connects WITHOUT an `appVersion` in its
 * Socket.IO handshake is a pre-handshake build — too old for any client-side
 * version gate to reach. When such a client tries to use a chat we do NOT run
 * Claude; instead we return this ephemeral notice telling the user to update.
 *
 * The text is rendered by the SAME assistant-text path every build (old ones
 * included) already knows how to render — see
 * `ChatExecutionService.emitOutdatedClientNotice`.
 */
export const OUTDATED_APP_MESSAGE = [
  '⚠️ **Your app is out of date**',
  '',
  'This version of Portable is too old to keep running. Please update to the latest version to continue:',
  '',
  '• **iOS** — update or reinstall from the App Store: https://apps.apple.com/app/portable-dev/id6758861546',
  '• **Android** — update or reinstall from Google Play: https://play.google.com/store/apps/details?id=dev.portable.app',
  '',
  'Once you are on the latest version, your chats will work again.',
].join('\n');
