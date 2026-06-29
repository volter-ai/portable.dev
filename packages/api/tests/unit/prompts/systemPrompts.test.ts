/**
 * System Prompt Construction - Unit Tests
 *
 * Test Philosophy: Comprehensive tests over granular tests
 *
 * Each test validates a complete scenario rather than individual assertions.
 * This makes tests easier to understand, maintain, and debug.
 *
 * What we test:
 * 1. Complete template integrity for each agent type
 * 2. Context injection (user info, repo paths, runtime state)
 * 3. Critical regression: placeholder replacement doesn't lose content
 * 4. Template immutability across multiple calls
 * 5. Edge cases (missing fields, fallbacks, special characters)
 *
 * Historical context:
 * - Jan 2026: Bug where content after {universalCoreSections} disappeared
 * - This test suite prevents that regression
 */

import { describe, it, expect } from 'bun:test';
import {
  buildSystemPromptFromSetup,
  getUniversalCoreSections,
  getCodeSections,
} from '../../../src/prompts/systemPrompts.js';
import { FREESTYLE_SETUP } from '../../../src/prompts/agents/freestyle.js';
import { ORCHESTRATOR_SETUP } from '../../../src/prompts/agents/orchestrator.js';

describe('System Prompt Construction', () => {
  const minimalContext = {
    repoPath: '/test/repo',
    username: 'testuser',
    userEmail: 'test@example.com',
    userId: 'test-user-id',
    localReposList: '',
  };

  describe('Freestyle Agent', () => {
    it('should generate complete prompt with all sections in correct order', () => {
      const prompt = buildSystemPromptFromSetup('freestyle', minimalContext);

      // No unreplaced placeholders
      expect(prompt).not.toContain('{universalCoreSections}');
      expect(prompt).not.toContain('{codeSections}');
      expect(prompt).not.toContain('{githubSections}');
      expect(prompt).not.toContain('{runtimeTunnels}');

      // All required sections present
      const requiredSections = {
        // Universal core sections
        'COMPLETION:': 'completion marker',
        'CRITICAL - PROCESS MANAGEMENT:': 'process management',
        'PORT CONFLICTS:': 'port conflict handling',
        'IMPORTANT - WORKING DIRECTORY:': 'working directory info',
        'RICH UI COMPONENTS:': 'rich UI components',

        // Code sections
        'CODE ANALYSIS:': 'code analysis tools',
        'ast-grep': 'ast-grep tool',

        // Freestyle-specific: Media generation (static content after placeholders)
        'MEDIA GENERATION CAPABILITIES:': 'media generation header',
        'Generate images from text descriptions': 'image generation',
        'Generate videos from text descriptions': 'video generation',
      };

      Object.entries(requiredSections).forEach(([section, description]) => {
        expect(prompt).toContain(section);
      });

      // Verify ordering (critical - proves placeholders work sequentially)
      const indices = {
        userInfo: prompt.indexOf('# Current User Information'),
        completion: prompt.indexOf('COMPLETION:'),
        processManagement: prompt.indexOf('CRITICAL - PROCESS MANAGEMENT:'),
        codeAnalysis: prompt.indexOf('CODE ANALYSIS:'),
        mediaCapabilities: prompt.indexOf('MEDIA GENERATION CAPABILITIES:'),
        claudeMdWarning: prompt.indexOf('⚠️  WARNING: NO CLAUDE.md FOUND'),
      };

      // Validate sequential ordering
      expect(indices.completion).toBeGreaterThan(indices.userInfo);
      expect(indices.processManagement).toBeGreaterThan(indices.completion);
      expect(indices.codeAnalysis).toBeGreaterThan(indices.processManagement);
      expect(indices.mediaCapabilities).toBeGreaterThan(indices.codeAnalysis);
      expect(indices.claudeMdWarning).toBeGreaterThan(indices.mediaCapabilities);
    });
  });

  describe('Orchestrator Agent', () => {
    it('should generate prompt with delegation instructions instead of tool capabilities', () => {
      const prompt = buildSystemPromptFromSetup('orchestrator', minimalContext);

      // Has universal core sections
      expect(prompt).toContain('COMPLETION:');
      expect(prompt).toContain('CRITICAL - PROCESS MANAGEMENT:');

      // Has orchestrator-specific delegation instructions
      const orchestratorSections = [
        'YOUR PRIMARY ROLE:',
        'You are a task coordinator',
        'WHEN TO DO WORK YOURSELF:',
        'WHEN TO SPAWN A WORKER CHAT:',
        'REPOSITORY SELECTION FOR WORKER CHATS:',
        'MONITORING PROTOCOL',
        'portable.chat.create', // SDK call example
      ];

      orchestratorSections.forEach((section) => {
        expect(prompt).toContain(section);
      });

      // Does NOT have freestyle capabilities (delegates to workers)
      expect(prompt).not.toContain('MEDIA GENERATION CAPABILITIES:');

      // No placeholder remnants
      expect(prompt).not.toContain('{universalCoreSections}');
      expect(prompt).not.toContain('{runtimeTunnels}');
    });
  });

  describe('Best Practice Agent', () => {
    it('should generate prompt with SOP workflow support', () => {
      const prompt = buildSystemPromptFromSetup('best-practice', minimalContext);

      // Has core sections
      expect(prompt).toContain('COMPLETION:');
      expect(prompt).toContain('CRITICAL - PROCESS MANAGEMENT:');

      // No placeholder remnants (SOP is optional and injected separately)
      expect(prompt).not.toContain('{sopWorksheet}');
      expect(prompt).not.toContain('{universalCoreSections}');
    });
  });

  describe('REGRESSION: Jan 2026 Placeholder Bug', () => {
    it('CRITICAL: content after first placeholder must not be lost', () => {
      /**
       * Bug: After replacing {universalCoreSections}, all subsequent content was removed
       * Root cause: String replacement was accidentally truncating the template
       *
       * This test specifically validates:
       * 1. All 4 placeholders are replaced (freestyle template)
       * 2. Static content AFTER placeholders still exists
       * 3. Multiple sequential replacements don't corrupt the template
       */
      const prompt = buildSystemPromptFromSetup('freestyle', minimalContext);

      // Verify each placeholder was replaced (not present in output)
      expect(prompt).not.toContain('{universalCoreSections}'); // 1st placeholder
      expect(prompt).not.toContain('{codeSections}'); // 2nd placeholder
      expect(prompt).not.toContain('{githubSections}'); // 3rd placeholder
      expect(prompt).not.toContain('{runtimeTunnels}'); // 4th placeholder

      // Verify content from each placeholder appears
      expect(prompt).toContain('COMPLETION:'); // From {universalCoreSections}
      expect(prompt).toContain('CODE ANALYSIS:'); // From {codeSections}

      // CRITICAL: Static content AFTER all placeholders must exist
      expect(prompt).toContain('MEDIA GENERATION CAPABILITIES:');
      expect(prompt).toContain('Generate images from text descriptions');

      // Verify content exists AFTER the last placeholder replacement
      const lastPlaceholderContent = Math.max(
        prompt.lastIndexOf('COMPLETION:'),
        prompt.lastIndexOf('CODE ANALYSIS:')
      );
      const staticContentAfterPlaceholders = prompt.indexOf('MEDIA GENERATION CAPABILITIES:');

      expect(staticContentAfterPlaceholders).toBeGreaterThan(lastPlaceholderContent);

      // Verify no duplicate sections (each section appears exactly once)
      const countOccurrences = (str: string, substr: string) => {
        return (str.match(new RegExp(substr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [])
          .length;
      };

      expect(countOccurrences(prompt, 'COMPLETION:')).toBe(1);
      expect(countOccurrences(prompt, 'CODE ANALYSIS:')).toBe(1);
      expect(countOccurrences(prompt, 'MEDIA GENERATION CAPABILITIES:')).toBe(1);
    });
  });

  describe('Context Integration', () => {
    it('should inject all context types correctly', () => {
      const fullContext = {
        repoPath: '/workspace/test-repo',
        owner: 'testowner',
        repo: 'testrepo',
        username: 'testuser',
        userEmail: 'test@example.com',
        userId: 'test-user-id',
        localReposList: '\n\nLOCALLY CLONED REPOSITORIES:\n- owner/repo1\n- owner/repo2',
        pageContext: { type: 'repo', owner: 'testowner', repo: 'testrepo' },
        runtimeState: 'Running processes:\n- dev server on :3000',
        aiStyle: 'concise' as const,
        customAiStylePrompt: 'Be extra brief',
      };

      const prompt = buildSystemPromptFromSetup('freestyle', fullContext);

      // User context
      expect(prompt).toContain('testuser');
      expect(prompt).toContain('test@example.com');

      // Repo context
      expect(prompt).toContain('testowner/testrepo');
      expect(prompt).toContain('Repository path: /workspace/test-repo');

      // Local repos list
      expect(prompt).toContain('LOCALLY CLONED REPOSITORIES:');
      expect(prompt).toContain('owner/repo1');
      expect(prompt).toContain('owner/repo2');

      // Runtime state
      expect(prompt).toContain('Running processes:');
      expect(prompt).toContain('dev server on :3000');

      // Template sections still present
      expect(prompt).toContain('COMPLETION:');
      expect(prompt).toContain('MEDIA GENERATION CAPABILITIES:');
    });

    it('should handle workspace mode vs repo mode correctly', () => {
      // Workspace mode (no owner/repo)
      const workspaceContext = { ...minimalContext, repoPath: '/workspace' };
      const workspacePrompt = buildSystemPromptFromSetup('freestyle', workspaceContext);
      expect(workspacePrompt).toContain('Claude workspace root directory: /workspace');

      // Repo mode (with owner/repo)
      const repoContext = { ...minimalContext, owner: 'owner', repo: 'repo' };
      const repoPrompt = buildSystemPromptFromSetup('freestyle', repoContext);
      expect(repoPrompt).toContain('You are running Claude Code in the repository: owner/repo');
      expect(repoPrompt).toContain('Repository path: /test/repo');
    });
  });

  describe('Template Immutability', () => {
    it('should not mutate template across multiple calls', () => {
      const prompt1 = buildSystemPromptFromSetup('freestyle', minimalContext);
      const prompt2 = buildSystemPromptFromSetup('freestyle', minimalContext);
      const prompt3 = buildSystemPromptFromSetup('freestyle', minimalContext);

      // All prompts should be identical
      expect(prompt1).toEqual(prompt2);
      expect(prompt2).toEqual(prompt3);

      // All should have critical sections
      [prompt1, prompt2, prompt3].forEach((prompt) => {
        expect(prompt).toContain('MEDIA GENERATION CAPABILITIES:');
        expect(prompt).toContain('COMPLETION:');
      });
    });

    it('should not cross-contaminate between different agents', () => {
      const freestylePrompt1 = buildSystemPromptFromSetup('freestyle', minimalContext);
      const orchestratorPrompt = buildSystemPromptFromSetup('orchestrator', minimalContext);
      const freestylePrompt2 = buildSystemPromptFromSetup('freestyle', minimalContext);

      // Freestyle should be consistent
      expect(freestylePrompt1).toEqual(freestylePrompt2);

      // Each agent should have its own capabilities
      expect(freestylePrompt1).toContain('MEDIA GENERATION CAPABILITIES:');
      expect(orchestratorPrompt).toContain('WHEN TO SPAWN A WORKER CHAT:');

      // No cross-contamination
      expect(orchestratorPrompt).not.toContain('MEDIA GENERATION CAPABILITIES:');
      expect(freestylePrompt1).not.toContain('WHEN TO SPAWN A WORKER CHAT:');
    });
  });

  describe('Edge Cases & Error Handling', () => {
    it('should handle missing optional context fields gracefully', () => {
      const minContext = {
        repoPath: '/test',
        username: 'user',
        userEmail: 'email@test.com',
        userId: 'id',
        localReposList: '',
      };

      expect(() => buildSystemPromptFromSetup('freestyle', minContext)).not.toThrow();

      const prompt = buildSystemPromptFromSetup('freestyle', minContext);
      expect(prompt).toContain('COMPLETION:');
      expect(prompt).toContain('MEDIA GENERATION CAPABILITIES:');
    });

    it('should fallback to freestyle for unknown agent types', () => {
      const prompt = buildSystemPromptFromSetup('unknown-agent-xyz', minimalContext);

      // Should generate freestyle prompt as fallback
      expect(prompt).toContain('MEDIA GENERATION CAPABILITIES:');
      expect(prompt).toContain('COMPLETION:');
    });

    it('should handle special characters in context without corruption', () => {
      const specialContext = {
        repoPath: '/test/repo with spaces/and-dashes',
        username: 'test-user_123',
        userEmail: 'test+tag@example.com',
        userId: 'user_id_with_underscores',
        localReposList: '\n\nRepos:\n- org/repo-name\n- org/repo_underscore',
      };

      const prompt = buildSystemPromptFromSetup('freestyle', specialContext);

      expect(prompt).toContain('test-user_123');
      expect(prompt).toContain('test+tag@example.com');
      expect(prompt).toContain('repo with spaces');
      expect(prompt).toContain('org/repo-name');

      // Template sections still intact
      expect(prompt).toContain('COMPLETION:');
      expect(prompt).toContain('MEDIA GENERATION CAPABILITIES:');
    });

    it('should preserve unicode characters and emoji', () => {
      const prompt = buildSystemPromptFromSetup('freestyle', minimalContext);

      // Emoji preserved
      expect(prompt).toContain('🔴 FORBIDDEN:');
      expect(prompt).toContain('✅ CORRECT:');
      expect(prompt).toContain('⚠️');

      // Unicode box drawing characters preserved
      expect(prompt).toContain('━');
    });
  });

  describe('Section Builder Functions', () => {
    it('should export modular section builders with correct structure', () => {
      const universalSections = getUniversalCoreSections();
      const codeSections = getCodeSections();

      // Universal sections structure
      expect(universalSections).toHaveProperty('completion');
      expect(universalSections).toHaveProperty('processManagement');
      expect(universalSections).toHaveProperty('portConflicts');
      expect(universalSections).toHaveProperty('workspace');
      expect(universalSections).toHaveProperty('secrets');
      expect(universalSections).toHaveProperty('richComponents');

      // Content validation (spot check)
      expect(universalSections.completion).toContain('COMPLETION:');
      expect(universalSections.completion).toContain('<promise>COMPLETE</promise>');
      expect(universalSections.processManagement).toContain('pkill');
      expect(universalSections.processManagement).toContain('KillShell');

      // Code sections structure
      expect(codeSections).toHaveProperty('codeAnalysis');
      expect(codeSections.codeAnalysis).toContain('CODE ANALYSIS:');
      expect(codeSections.codeAnalysis).toContain('ast-grep');
      expect(codeSections.codeAnalysis).toContain('WHEN TO USE AST-GREP VS GREP:');
    });
  });

  describe('Template Source Integrity', () => {
    it('should have well-formed source templates with all placeholders', () => {
      // Freestyle template
      const freestyleTemplate = FREESTYLE_SETUP.systemPromptTemplate;
      expect(freestyleTemplate).toContain('{universalCoreSections}');
      expect(freestyleTemplate).toContain('{codeSections}');
      expect(freestyleTemplate).toContain('{githubSections}');
      expect(freestyleTemplate).toContain('{runtimeTunnels}');
      expect(freestyleTemplate).toContain('MEDIA GENERATION CAPABILITIES:');

      // Orchestrator template
      const orchestratorTemplate = ORCHESTRATOR_SETUP.systemPromptTemplate;
      expect(orchestratorTemplate).toContain('{universalCoreSections}');
      expect(orchestratorTemplate).toContain('{runtimeTunnels}');
      expect(orchestratorTemplate).toContain('YOUR PRIMARY ROLE:');
    });
  });

  describe('Performance', () => {
    it('should handle large context efficiently', () => {
      const largeContext = {
        ...minimalContext,
        localReposList:
          '\n\nLOCALLY CLONED REPOSITORIES:\n' +
          Array.from({ length: 100 }, (_, i) => `- owner/repo${i}`).join('\n'),
      };

      const startTime = performance.now();
      const prompt = buildSystemPromptFromSetup('freestyle', largeContext);
      const endTime = performance.now();

      // Should complete quickly (< 100ms)
      expect(endTime - startTime).toBeLessThan(100);

      // Should contain sample repos
      expect(prompt).toContain('repo0');
      expect(prompt).toContain('repo99');
    });

    it('should not degrade performance over repeated calls', () => {
      const times: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        buildSystemPromptFromSetup('freestyle', minimalContext);
        times.push(performance.now() - start);
      }

      const firstThreeAvg = (times[0] + times[1] + times[2]) / 3;
      const lastThreeAvg = (times[7] + times[8] + times[9]) / 3;

      // Later calls shouldn't be significantly slower (guards against leaks /
      // O(n^2) growth). Floor the bound at an absolute 5ms so sub-millisecond
      // scheduler/GC jitter can't trip the ratio: these calls run in well under
      // 1ms, so without a floor the ratio is dominated by noise (more so now
      // that CI runs without coverage instrumentation). A real regression would
      // push calls into the tens of ms, far past this floor.
      expect(lastThreeAvg).toBeLessThan(Math.max(firstThreeAvg * 4, 5));
    });
  });
});
