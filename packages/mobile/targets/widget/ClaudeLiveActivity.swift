// ClaudeLiveActivity.swift — issue #1434
//
// The SwiftUI Live Activity UI: the Lock Screen / banner presentation + the
// Dynamic Island (compact, minimal, expanded) for an ongoing chat execution.
// `Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)` renders
// a self-ticking elapsed counter entirely on the OS side — JS never pushes time.

import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.2, *)
struct ClaudeLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ClaudeActivityAttributes.self) { context in
      // ---- LOCK SCREEN / BANNER ----
      LockScreenView(context: context)
        .padding()
        .activityBackgroundTint(Color.black.opacity(0.85))
        .activitySystemActionForegroundColor(Color.white)

    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: context.state.isRunning ? "sparkles" : "checkmark.circle.fill")
            .foregroundStyle(context.state.isRunning ? .purple : .green)
            .font(.title2)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.state.isRunning {
            Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
              .monospacedDigit()
              .frame(maxWidth: 64)
              .multilineTextAlignment(.trailing)
          } else {
            Text("Done").foregroundStyle(.green)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.attributes.title)
            .font(.headline)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.isRunning ? context.state.lastToolLabel : "Finished")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      } compactLeading: {
        Image(systemName: context.state.isRunning ? "sparkles" : "checkmark.circle.fill")
          .foregroundStyle(context.state.isRunning ? .purple : .green)
      } compactTrailing: {
        if context.state.isRunning {
          Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
            .monospacedDigit()
            .frame(maxWidth: 44)
        }
      } minimal: {
        Image(systemName: context.state.isRunning ? "sparkles" : "checkmark.circle.fill")
          .foregroundStyle(context.state.isRunning ? .purple : .green)
      }
      .keylineTint(Color.purple)
    }
  }
}

@available(iOS 16.2, *)
struct LockScreenView: View {
  let context: ActivityViewContext<ClaudeActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(context.attributes.title)
          .font(.headline)
          .lineLimit(1)
        Spacer()
        if context.state.isRunning {
          Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
            .monospacedDigit()
            .font(.headline)
            .foregroundStyle(.purple)
        } else {
          Text("Done").font(.headline).foregroundStyle(.green)
        }
      }

      Text(context.state.isRunning ? "Claude is thinking…" : "Finished")
        .font(.subheadline)
        .foregroundStyle(.secondary)

      if context.state.isRunning && !context.state.lastToolLabel.isEmpty {
        HStack(spacing: 6) {
          Image(systemName: "wrench.and.screwdriver")
            .font(.caption)
            .foregroundStyle(.tertiary)
          Text(context.state.lastToolLabel)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }

      if !context.attributes.repoName.isEmpty {
        Text(context.attributes.repoName)
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    }
  }
}

@main
struct ClaudeWidgetBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.2, *) {
      ClaudeLiveActivity()
    }
  }
}
