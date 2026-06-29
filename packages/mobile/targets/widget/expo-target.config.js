/**
 * Widget extension target for the ongoing-chat Live Activity (issue #1434),
 * wired by the `@bacons/apple-targets` config plugin. On `expo prebuild` this
 * adds a SwiftUI widget-extension target to the generated Xcode project that
 * hosts the Lock Screen / Dynamic Island Live Activity UI.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'widget',
  name: 'ClaudeWidgets',
  // ActivityKit + SwiftUI for the Live Activity UI; WidgetKit for the bundle.
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  deploymentTarget: '16.4',
};
