/**
 * useLinkedIssueViewer — opens the in-app issue detail for a chat's
 * linked GitHub issue. The chat list rows + the active-chat header call `open()`
 * with the chat's `linkedIssue`; this hosts the Tasks {@link TaskItemViewer}
 * modal (the only in-app issue/PR detail surface today — there are no routable
 * issue/PR screens yet, only the component-local viewers).
 *
 * A chat's `linkedIssue` is semantically an ISSUE (the backend
 * `link_issue_to_chat` tool). GitHub unifies issue/PR numbering, so the issue
 * viewer renders whatever the number resolves to.
 *
 * `TaskItemViewer` is loaded via a render-time `require` (the FileViewer
 * `loadPdfViewer` pattern) ONLY once a target is set, so the chat screens never
 * STATICALLY import the tasks-viewer graph. That avoids a chat↔tasks module
 * cycle (the tasks viewer imports the chat composer + stores) and keeps the
 * tasks-viewer mocks out of any test that never opens the viewer.
 */

import { useCallback, useState, type ComponentType, type ReactElement } from 'react';

import type { LinkedIssue } from './chrome/chatChromeStore';
// Type-only (Babel-erased) — the runtime module is loaded lazily below.
import type { TaskItemViewerProps } from '../tasks/viewer/TaskItemViewer';
import type { ViewerTarget } from '../tasks/viewer/viewerTypes';

export interface UseLinkedIssueViewer {
  /** Open the in-app detail for a chat's linked issue. */
  open: (linked: LinkedIssue) => void;
  /** The host element to render once in the screen (null until opened). */
  element: ReactElement | null;
}

export function useLinkedIssueViewer(): UseLinkedIssueViewer {
  const [target, setTarget] = useState<ViewerTarget | null>(null);

  const open = useCallback((linked: LinkedIssue) => {
    setTarget({ kind: 'issue', owner: linked.owner, repo: linked.repo, number: linked.number });
  }, []);

  const close = useCallback(() => setTarget(null), []);

  const element = target ? (
    <LinkedIssueViewerHost target={target} onClose={close} onOpenTarget={setTarget} />
  ) : null;

  return { open, element };
}

/** Render-time require of the Tasks viewer (keeps it out of the static graph). */
function LinkedIssueViewerHost(props: TaskItemViewerProps): ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TaskItemViewer } = require('../tasks/viewer/TaskItemViewer') as {
    TaskItemViewer: ComponentType<TaskItemViewerProps>;
  };
  return <TaskItemViewer {...props} />;
}
