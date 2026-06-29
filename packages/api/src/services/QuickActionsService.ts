import fs from 'fs';
import path from 'path';

export type QuickAction = {
  id: string;
  label: string;
  labelBold?: string;
  icon?: string;
  priority?: number;
} & (
  | { type: 'message'; prompt: string }
  | { type: 'runtime'; resourceType: 'tunnel' | 'process'; resourceId: string }
);

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Service for detecting and generating contextual quick actions for repositories
 *
 * This service analyzes a repo's structure and configuration to suggest
 * intelligent quick actions based on:
 * - package.json scripts
 * - Framework detection (Vite, Next.js, etc.)
 * - Testing frameworks
 * - Build tools
 * - File patterns
 */
export class QuickActionsService {
  /**
   * Detects the package manager used in a project
   */
  private detectPackageManager(repoPath: string): string {
    if (fs.existsSync(path.join(repoPath, 'bun.lockb'))) return 'bun';
    if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
    return 'npm';
  }

  /**
   * Reads and parses package.json from a repository
   */
  private readPackageJson(repoPath: string): PackageJson | null {
    const packageJsonPath = path.join(repoPath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[QuickActionsService] Error reading package.json:', error);
      return null;
    }
  }

  /**
   * Detects the framework used in the project
   */
  private detectFramework(packageJson: PackageJson): string | null {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    if (deps['vite']) return 'vite';
    if (deps['next']) return 'nextjs';
    if (deps['@remix-run/react']) return 'remix';
    if (deps['nuxt']) return 'nuxt';
    if (deps['@angular/core']) return 'angular';
    if (deps['vue'] && deps['@vue/cli-service']) return 'vue-cli';
    if (deps['react-scripts']) return 'create-react-app';
    if (deps['gatsby']) return 'gatsby';
    if (deps['svelte']) return 'svelte';

    return null;
  }

  /**
   * Detects testing framework
   */
  private detectTestFramework(packageJson: PackageJson): string | null {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    if (deps['vitest']) return 'vitest';
    if (deps['jest']) return 'jest';
    if (deps['@playwright/test']) return 'playwright';
    if (deps['cypress']) return 'cypress';
    if (deps['mocha']) return 'mocha';
    if (deps['ava']) return 'ava';

    return null;
  }

  /**
   * Generates dev/start action with intelligent prompt
   */
  private generateStartAction(
    owner: string,
    repo: string,
    scripts: Record<string, string>,
    packageManager: string,
    framework: string | null
  ): QuickAction | null {
    const repoFullName = `${owner}/${repo}`;

    // Prefer 'dev' over 'start' for development
    if (scripts.dev) {
      let prompt = `Start the development server for ${repoFullName} by running \`${packageManager} run dev\``;

      // Add framework-specific context
      if (framework === 'vite') {
        prompt += '. This is a Vite project - the dev server supports HMR (Hot Module Replacement)';
      } else if (framework === 'nextjs') {
        prompt += '. This is a Next.js project - it will be available at http://localhost:3000';
      } else if (framework === 'remix') {
        prompt += '. This is a Remix project - it will start both the dev server and asset watcher';
      }

      // Add tunnel creation reminder
      prompt +=
        '. After the server starts and you see the port number, create a tunnel using the create_tunnel tool so the user can access it';

      return {
        id: 'start-dev',
        label: 'Start app',
        icon: 'play',
        type: 'message',
        prompt,
        priority: 100, // Highest priority
      };
    }

    if (scripts.start) {
      return {
        id: 'start-app',
        label: 'Start app',
        icon: 'play',
        type: 'message',
        prompt: `Start the application for ${repoFullName} by running \`${packageManager} start\`. This typically starts the production build`,
        priority: 95,
      };
    }

    return null;
  }

  /**
   * Generates test action with intelligent prompt
   */
  private generateTestAction(
    owner: string,
    repo: string,
    scripts: Record<string, string>,
    packageManager: string,
    testFramework: string | null
  ): QuickAction | null {
    if (!scripts.test) return null;

    const repoFullName = `${owner}/${repo}`;
    let prompt = `Run the test suite for ${repoFullName} by running \`${packageManager} test\``;

    // Add test framework-specific context
    if (testFramework === 'vitest') {
      prompt += '. This uses Vitest - tests will run in watch mode';
    } else if (testFramework === 'jest') {
      prompt += '. This uses Jest';
    } else if (testFramework === 'playwright') {
      prompt += '. This uses Playwright for E2E testing';
    } else if (testFramework === 'cypress') {
      prompt += '. This uses Cypress for E2E testing';
    }

    return {
      id: 'run-tests',
      label: 'Run tests',
      icon: 'flask',
      type: 'message',
      prompt,
      priority: 80,
    };
  }

  /**
   * Generates build action
   */
  private generateBuildAction(
    owner: string,
    repo: string,
    scripts: Record<string, string>,
    packageManager: string,
    framework: string | null
  ): QuickAction | null {
    if (!scripts.build) return null;

    const repoFullName = `${owner}/${repo}`;
    let prompt = `Build the application for ${repoFullName} by running \`${packageManager} run build\``;

    if (framework === 'vite') {
      prompt += '. This will create an optimized production build in the dist/ directory';
    } else if (framework === 'nextjs') {
      prompt += '. This will create an optimized production build in .next/';
    } else if (framework === 'remix') {
      prompt += '. This will compile the app for production';
    }

    return {
      id: 'build-app',
      label: 'Build',
      icon: 'hammer',
      type: 'message',
      prompt,
      priority: 70,
    };
  }

  /**
   * Generates type check action
   */
  private generateTypeCheckAction(
    owner: string,
    repo: string,
    scripts: Record<string, string>,
    packageManager: string
  ): QuickAction | null {
    const repoFullName = `${owner}/${repo}`;

    if (scripts.typecheck) {
      return {
        id: 'typecheck',
        label: 'Type check',
        icon: 'check-circle',
        type: 'message',
        prompt: `Run type checking for ${repoFullName} by running \`${packageManager} run typecheck\`. This verifies TypeScript types without emitting files`,
        priority: 60,
      };
    }

    if (scripts.tsc) {
      return {
        id: 'typecheck',
        label: 'Type check',
        icon: 'check-circle',
        type: 'message',
        prompt: `Run type checking for ${repoFullName} by running \`${packageManager} run tsc\``,
        priority: 60,
      };
    }

    return null;
  }

  /**
   * Generates lint action
   */
  private generateLintAction(
    owner: string,
    repo: string,
    scripts: Record<string, string>,
    packageManager: string
  ): QuickAction | null {
    const repoFullName = `${owner}/${repo}`;

    if (scripts.lint) {
      return {
        id: 'lint',
        label: 'Lint',
        icon: 'wand-magic-sparkles',
        type: 'message',
        prompt: `Run linting for ${repoFullName} by running \`${packageManager} run lint\`. This checks code quality and style`,
        priority: 50,
      };
    }

    if (scripts.eslint) {
      return {
        id: 'lint',
        label: 'Lint',
        icon: 'wand-magic-sparkles',
        type: 'message',
        prompt: `Run ESLint for ${repoFullName} by running \`${packageManager} run eslint\``,
        priority: 50,
      };
    }

    return null;
  }

  /**
   * Main entry point: Get all relevant quick actions for a repository
   */
  getQuickActionsForRepo(
    owner: string,
    repo: string,
    repoPath: string,
    activeTunnels: Array<{ name: string; port: number; url: string; main?: boolean }> = []
  ): QuickAction[] {
    const packageJson = this.readPackageJson(repoPath);

    if (!packageJson) {
      return [];
    }

    const scripts = packageJson.scripts;
    const packageManager = this.detectPackageManager(repoPath);
    const framework = this.detectFramework(packageJson);
    const testFramework = this.detectTestFramework(packageJson);

    const actions: QuickAction[] = [];

    // Check if the MAIN tunnel is running (not just any tunnel)
    const hasMainTunnel = activeTunnels.some((t) => t.main === true);

    // NOTE: "Show" and "Restart" actions for tunnels are now generated on the client
    // in useChatQuickActions.ts, which allows them to be context-aware based on activeResource

    // Generate actions in priority order
    const generators = [
      // Skip "Start app" if main tunnel is already running (and only if scripts exist)
      () =>
        scripts && !hasMainTunnel
          ? this.generateStartAction(owner, repo, scripts, packageManager, framework)
          : null,
      () =>
        scripts
          ? this.generateTestAction(owner, repo, scripts, packageManager, testFramework)
          : null,
    ];

    for (const generator of generators) {
      const action = generator();
      if (action) {
        actions.push(action);
      }
    }

    // Sort by priority (highest first)
    actions.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Limit to top 6 actions (fits nicely in carousel)
    return actions.slice(0, 6);
  }
}
