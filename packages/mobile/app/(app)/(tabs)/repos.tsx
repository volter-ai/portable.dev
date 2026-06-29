import { RepoListScreen } from '@/features/repos';

// Repos tab (`/repos`) — the searchable, paginated repository list (US-E5-001).
// Thin shell. The repo DETAIL route lives at `app/repos/[owner]/[repo].tsx`
// (a stack route outside this tab group).
export default function ReposTab() {
  return <RepoListScreen />;
}
