// LiveActivitiesModule.swift — issue #1434
//
// The Expo native module that the JS `requireOptionalNativeModule('LiveActivities')`
// resolves to. Starts / updates / ends the ongoing-chat Live Activity via
// ActivityKit. `startedAt` is captured once at start and preserved across updates
// so the widget's `Text(timerInterval:)` ticks the elapsed time natively.
//
// Everything is guarded `#available(iOS 16.2, *)` + `areActivitiesEnabled`; on an
// unsupported OS or when the user disabled Live Activities every call is a soft
// no-op (returns false / does nothing), never a thrown error surfaced to JS.

import ActivityKit
import ExpoModulesCore

public class LiveActivitiesModule: Module {
  public func definition() -> ModuleDefinition {
    // JS name — must match requireOptionalNativeModule('LiveActivities').
    Name("LiveActivities")

    Function("areActivitiesEnabled") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    AsyncFunction("startActivity") {
      (chatId: String, repoName: String, title: String, lastToolLabel: String) -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }

      // Already running for this chat → treat start as an update (don't double-start).
      if let existing = Self.findActivity(chatId: chatId) {
        let state = ClaudeActivityAttributes.ContentState(
          lastToolLabel: lastToolLabel,
          isRunning: true,
          startedAt: existing.content.state.startedAt,
          title: title
        )
        await existing.update(ActivityContent(state: state, staleDate: nil))
        return true
      }

      let attributes = ClaudeActivityAttributes(chatId: chatId, repoName: repoName, title: title)
      let state = ClaudeActivityAttributes.ContentState(
        lastToolLabel: lastToolLabel,
        isRunning: true,
        startedAt: Date(),
        title: title
      )

      do {
        _ = try Activity<ClaudeActivityAttributes>.request(
          attributes: attributes,
          content: ActivityContent(state: state, staleDate: nil),
          pushType: nil // local-only; no APNs push token
        )
        return true
      } catch {
        NSLog("[LiveActivities] start failed: \(error.localizedDescription)")
        return false
      }
    }

    AsyncFunction("updateActivity") {
      (chatId: String, lastToolLabel: String, isRunning: Bool) in
      guard #available(iOS 16.2, *) else { return }
      guard let activity = Self.findActivity(chatId: chatId) else { return }

      // Preserve the ORIGINAL startedAt so the live timer keeps running.
      let newState = ClaudeActivityAttributes.ContentState(
        lastToolLabel: lastToolLabel,
        isRunning: isRunning,
        startedAt: activity.content.state.startedAt,
        title: activity.attributes.title
      )
      await activity.update(ActivityContent(state: newState, staleDate: nil))
    }

    AsyncFunction("endActivity") { (chatId: String) in
      guard #available(iOS 16.2, *) else { return }
      guard let activity = Self.findActivity(chatId: chatId) else { return }

      let finalState = ClaudeActivityAttributes.ContentState(
        lastToolLabel: "Done",
        isRunning: false,
        startedAt: activity.content.state.startedAt,
        title: activity.attributes.title
      )
      await activity.end(
        ActivityContent(state: finalState, staleDate: nil),
        dismissalPolicy: .immediate
      )
    }
  }

  // Match a running activity by its immutable attributes.chatId — survives an app
  // relaunch (no JS-side handle is stored).
  @available(iOS 16.2, *)
  private static func findActivity(chatId: String) -> Activity<ClaudeActivityAttributes>? {
    return Activity<ClaudeActivityAttributes>.activities.first {
      $0.attributes.chatId == chatId
    }
  }
}
