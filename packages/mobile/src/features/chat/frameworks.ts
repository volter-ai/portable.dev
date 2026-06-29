/**
 * Framework catalog for the home input's "new project" framework selector. The
 * ids/labels reach `POST /api/projects/create`. Icons are site favicons (via the
 * Google favicon service), kept off the FontAwesome ban.
 */

export interface FrameworkOption {
  id: string;
  name: string;
  /** Homepage used to resolve the favicon (null = the "Empty" option, no icon). */
  url: string | null;
}

export const HOME_FRAMEWORKS: readonly FrameworkOption[] = [
  { id: 'empty', name: 'Empty', url: null },
  { id: 'bun', name: 'Bun', url: 'https://bun.sh' },
  { id: 'vite', name: 'Vite', url: 'https://vitejs.dev' },
  { id: 'nextjs', name: 'Next.js', url: 'https://nextjs.org' },
  { id: 'remix', name: 'Remix', url: 'https://remix.run' },
  { id: 'express', name: 'Express', url: 'https://expressjs.com' },
  { id: 'astro', name: 'Astro', url: 'https://astro.build' },
  { id: 'nuxt', name: 'Nuxt', url: 'https://nuxt.com' },
  { id: 'svelte', name: 'SvelteKit', url: 'https://kit.svelte.dev' },
  { id: 'rails', name: 'Rails', url: 'https://rubyonrails.org' },
  { id: 'django', name: 'Django', url: 'https://www.djangoproject.com' },
] as const;

/** The Google favicon-service URL for a site (matches the web `FrameworkSelector`). */
export function faviconUrl(siteUrl: string, size = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(siteUrl)}&sz=${size}`;
}
