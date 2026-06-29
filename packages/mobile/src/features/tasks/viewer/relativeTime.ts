/**
 * formatRelativeTime — the viewer-timeline format: "just now" /
 * "N minute(s)/hour(s)/day(s) ago" under 7
 * days, then an absolute date ("Mar 4", "+ year" when not the current year).
 * Distinct ON PURPOSE from the compact `formatTimeAgo` ("3d ago") the cards
 * and the PR author block use — both formats are kept. (The static native rows
 * do not re-render on an interval — accepted gap.)
 */

export function formatRelativeTime(date: string, nowMs: number = Date.now()): string {
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.floor((nowMs - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const d = new Date(date);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
