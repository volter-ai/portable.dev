import { router, useLocalSearchParams } from 'expo-router';

import { FileViewerScreen } from '@/features/file-viewer';

// `/repos/:owner/:repo/file/<path...>` route — the repository file viewer
// (US-E5-003). Thin shell: reads `owner`/`repo` + the catch-all file `path`, and
// wires breadcrumb navigation back to the repo at a directory.
export default function FileViewRoute() {
  const { owner, repo, path } = useLocalSearchParams<{
    owner: string;
    repo: string;
    // Catch-all segments: a string (single) or string[] (nested) at runtime.
    path?: string | string[];
  }>();

  const filePath = Array.isArray(path) ? path.join('/') : (path ?? '');

  const repoTarget = (expandPath: string) => ({
    pathname: '/repos/[owner]/[repo]' as const,
    // The directory tree lives in the repo's Files tab — breadcrumb/back targets land there.
    params: { owner: owner ?? '', repo: repo ?? '', tab: 'files', expandPath },
  });

  return (
    <FileViewerScreen
      owner={owner ?? ''}
      repo={repo ?? ''}
      filePath={filePath}
      onBack={() => {
        // AC4: on a deep-link cold-launch canDismiss()=false → no prior screen
        // to back to; navigate to the repo Files tab instead of a silent no-op.
        if (router.canDismiss()) {
          router.back();
        } else {
          router.navigate(repoTarget(''));
        }
      }}
      onNavigate={(dirPath) => {
        // dismissTo pops the stack back to the repo screen so router.back() from
        // the file view no longer replays a prior file (AC2). canDismiss guard
        // handles a deep-link entry where only this screen is on the stack (AC4).
        if (router.canDismiss()) {
          router.dismissTo(repoTarget(dirPath));
        } else {
          router.navigate(repoTarget(dirPath));
        }
      }}
    />
  );
}
