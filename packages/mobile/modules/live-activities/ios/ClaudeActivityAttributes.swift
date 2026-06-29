// ClaudeActivityAttributes.swift — issue #1434
//
// The ActivityKit attributes for the ongoing-chat Live Activity.
//
// ⚠️ This file is compiled into BOTH targets: the app's local module (here) and
// the widget extension (`targets/widget/ClaudeActivityAttributes.swift`). The two
// copies MUST stay byte-identical — if they drift, `Activity.request` from the app
// produces a state the widget can't decode and the activity renders blank. Keep
// them in lockstep.
//
// `startedAt` is a `Date` so the widget renders a self-updating elapsed timer via
// `Text(timerInterval:)` WITHOUT the JS side pushing a per-second tick.

import ActivityKit
import Foundation

public struct ClaudeActivityAttributes: ActivityAttributes {
  public typealias ContentState = ClaudeContentState

  // Immutable for the activity's lifetime — used to find the activity by chatId.
  public let chatId: String
  public let repoName: String
  public let title: String

  public init(chatId: String, repoName: String, title: String) {
    self.chatId = chatId
    self.repoName = repoName
    self.title = title
  }
}

public struct ClaudeContentState: Codable, Hashable {
  public var lastToolLabel: String
  public var isRunning: Bool
  public var startedAt: Date // drives the LIVE timer in the widget — no JS tick
  public var title: String

  public init(lastToolLabel: String, isRunning: Bool, startedAt: Date, title: String) {
    self.lastToolLabel = lastToolLabel
    self.isRunning = isRunning
    self.startedAt = startedAt
    self.title = title
  }
}
