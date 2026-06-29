import { CredentialResolver, type CredentialResolverDeps } from './CredentialResolver.js';
import {
  InteractiveCredentialLogin,
  type InteractiveCredentialLoginDeps,
} from './InteractiveCredentialLogin.js';

import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * The credential boot step — "find the keys already
 * on the user's OS and use them; if not found, ask them to log in."
 *
 * Run during BOOT, BEFORE the api child spawns (so it boots with the credentials
 * available in the SAME `LocalSecretStore` it reads + the env it inherits) and
 * BEFORE the Ink pairing screen owns the terminal (the interactive prompts own
 * the plain terminal). The sequence per credential:
 *
 *   1. DISCOVER across the OS priority ladder ({@link CredentialResolver}).
 *   2. If found, PERSIST it into the canonical store key the api reads (idempotent).
 *   3. If NOT found, run the interactive LOGIN fallback
 *      ({@link InteractiveCredentialLogin}) — Claude CLI login (then re-discover)
 *      for Anthropic; the OAuth device-flow offer for GitHub.
 *
 * It NEVER hard-blocks boot: a missing Anthropic credential is a LOUD warning
 * (AI will fail until configured) and GitHub is fully skippable (connect later
 * from the app). Everything is seam-injected so tests drive it with fakes.
 */

export interface PreparedCredentials {
  /** True when an Anthropic credential is available (discovered or via login). */
  anthropicConfigured: boolean;
  /** Which Anthropic discovery rung / login produced it (for logging). */
  anthropicSource?: string;
  /** True when a GitHub token is available (discovered or via login). */
  githubConfigured: boolean;
  /** Which GitHub discovery rung / login produced it (for logging). */
  githubSource?: string;
}

export interface PrepareCredentialsOptions {
  store: LocalSecretStore;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /**
   * Override the resolver (tests). Defaults to a real {@link CredentialResolver}
   * wired with the same store/env. Pass partial seams via {@link resolverDeps}.
   */
  resolver?: CredentialResolver;
  /** Extra resolver seams (fs/cli/platform/homedir) for the default resolver. */
  resolverDeps?: Partial<Omit<CredentialResolverDeps, 'store' | 'env'>>;
  /**
   * Override the interactive-login helper (tests). Defaults to a real
   * {@link InteractiveCredentialLogin}. Pass partial seams via {@link loginDeps}.
   */
  login?: InteractiveCredentialLogin;
  /** Extra interactive-login seams (detectBinary/runInteractive/confirm/fetch/sleep). */
  loginDeps?: Partial<Omit<InteractiveCredentialLoginDeps, 'store' | 'env' | 'log' | 'resolver'>>;
  /** Skip the interactive login fallback (CI / non-interactive). Default false. */
  skipInteractive?: boolean;
}

/**
 * Discover-then-login for BOTH Anthropic and GitHub. Returns the resulting
 * configured state. Pure orchestration over the two seam-injected collaborators;
 * never throws.
 */
export async function prepareCredentials(
  options: PrepareCredentialsOptions
): Promise<PreparedCredentials> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));

  const resolver =
    options.resolver ??
    new CredentialResolver({ store: options.store, env, ...options.resolverDeps });

  const login =
    options.login ??
    new InteractiveCredentialLogin({
      store: options.store,
      resolver,
      env,
      log,
      ...options.loginDeps,
    });

  // ---- ANTHROPIC -----------------------------------------------------------
  let anthropic = await resolver.discoverAnthropic();
  if (anthropic.found) {
    resolver.persistAnthropic(anthropic);
    log(`[launcher] ✓ Anthropic credential ready (found via ${anthropic.source}).`);
  } else if (!options.skipInteractive) {
    anthropic = await login.ensureAnthropic();
  } else {
    log('[launcher] ⚠ No Anthropic credential found — AI features will fail until you set one.');
  }

  // ---- GITHUB --------------------------------------------------------------
  let github = await resolver.discoverGitHub();
  if (github.found) {
    await resolver.persistGitHub(github);
    log(`[launcher] ✓ GitHub access ready (found via ${github.source}).`);
  } else if (!options.skipInteractive) {
    github = await login.ensureGitHub();
  } else {
    log('[launcher] ⚠ GitHub not connected — connect it later from the Portable app.');
  }

  return {
    anthropicConfigured: anthropic.found,
    anthropicSource: anthropic.source,
    githubConfigured: github.found,
    githubSource: github.source,
  };
}
