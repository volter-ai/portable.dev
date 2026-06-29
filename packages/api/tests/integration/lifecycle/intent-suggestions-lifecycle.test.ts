/**
 * Intent Analysis & Suggestions Service Lifecycle Tests
 *
 * THE STORY: "Maya getting AI-powered assistance on her home page"
 *
 * Maya is a developer using the AI assistant. When she opens the app:
 * 1. SuggestionsService generates quick action suggestions based on her tasks
 * 2. When she types a message, IntentAnalysisService determines what she wants
 * 3. The system routes her to the appropriate action
 *
 * LOCAL-FIRST: both services run a one-shot Claude (Haiku) call on the user's OWN
 * Anthropic credential via LocalAiHelper. When no local
 * credential is configured they DEGRADE GRACEFULLY (heuristic intent / empty
 * suggestions) instead of throwing.
 *
 * REAL SERVICES:
 * - ✅ IntentAnalysisService - User intent analysis logic
 * - ✅ SuggestionsService - AI-powered suggestions with caching
 *
 * MOCKED:
 * - 🔴 LocalAiHelper - the user's own Anthropic (Haiku) one-shot call
 * - 🔴 GitHubApiService - Repository and task data
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ========================================
// MOCK SETUP - Must be before service imports
// ========================================

// Stand-in for LocalAiHelper.completeJson(): branches on the prompt and returns the
// PARSED object directly.
const mockCompleteJson = mock(async (prompt: string) => {
  // Intent analysis - check for key phrases in the USER MESSAGE (not the full prompt template)
  if (prompt.includes('Analyze this user message')) {
    const userMessageMatch = prompt.match(/User message: "([^"]+)"/);
    const userMessage = userMessageMatch ? userMessageMatch[1].toLowerCase() : '';

    // Existing repo intent - check first because "fix" is more specific
    if (
      userMessage.includes('fix') ||
      userMessage.includes('bug') ||
      userMessage.includes('update')
    ) {
      return {
        reasoning: 'User wants to work on existing repository',
        intentType: 'existing-repo',
        suggestedName: 'bug-fix-task',
        suggestedFramework: null,
        useExistingRepo: { owner: 'testowner', repo: 'testrepo' },
        confidence: 0.88,
      };
    }
    // New project intent
    if (
      userMessage.includes('create') ||
      userMessage.includes('build') ||
      userMessage.includes('start') ||
      userMessage.includes('new')
    ) {
      return {
        reasoning: 'User wants to create a new application from scratch',
        intentType: 'new-repo',
        suggestedName: 'my-new-app',
        suggestedFramework: 'bun',
        useExistingRepo: null,
        confidence: 0.95,
      };
    }
    // Simple task (default)
    return {
      reasoning: 'User has a simple question or task',
      intentType: 'simple-task',
      suggestedName: 'quick-task',
      suggestedFramework: null,
      useExistingRepo: null,
      confidence: 0.92,
    };
  }

  // Suggestions - check for suggestion-related prompts
  if (prompt.includes('suggestion') || prompt.includes('TASKS:') || prompt.includes('Generate')) {
    return {
      suggestions: [
        {
          name: 'Fix login bug',
          completion: ' in authentication flow on testrepo',
          repo: { owner: 'testowner', name: 'testrepo' },
          taskReference: 'Login page not working',
          issueNumber: 42,
        },
        {
          name: 'Add dark mode',
          completion: ' theme toggle to settings page',
          repo: { owner: 'testowner', name: 'ui-components' },
          taskReference: 'Add dark mode support',
          issueNumber: 15,
        },
      ],
    };
  }

  return {};
});

/** Build a fake LocalAiHelper. `available=false` simulates no local Anthropic credential. */
function createMockLocalAiHelper(available: boolean) {
  return {
    isAvailable: () => available,
    complete: mock(async () => ''),
    completeJson: mockCompleteJson,
  } as any;
}

mock.module('../../../src/config/featureFlags.js', () => ({
  FEATURE_FLAGS: {
    ENABLE_SUGGESTIONS: true,
  },
}));

// ========================================
// IMPORT SERVICES AFTER MOCKS
// ========================================

import { IntentAnalysisService } from '../../../src/services/IntentAnalysisService';
import { SuggestionsService } from '../../../src/services/SuggestionsService';

// ========================================
// MOCK GITHUB API SERVICE
// ========================================

class MockGitHubApiService {
  tasksCache = new Map<string, any>();

  constructor() {
    this.initializeTestData();
  }

  initializeTestData() {
    this.tasksCache.set('maya@example.com_my', {
      data: {
        open_issues: [
          {
            title: 'Login page not working',
            number: 42,
            repository: {
              owner: { login: 'testowner', avatarUrl: 'https://github.com/testowner.png' },
              name: 'testrepo',
            },
          },
          {
            title: 'Add dark mode support',
            number: 15,
            repository: {
              owner: { login: 'testowner', avatarUrl: 'https://github.com/testowner.png' },
              name: 'ui-components',
            },
          },
        ],
        prs: [],
      },
    });
  }

  async getSimpleReposList(req: any): Promise<string[]> {
    return ['testowner/testrepo', 'testowner/ui-components'];
  }
}

// ========================================
// TEST SUITES
// ========================================

describe('Intent Analysis & Suggestions - AI-Powered User Assistance', () => {
  let intentAnalysisService: IntentAnalysisService;
  let suggestionsService: SuggestionsService;
  let mockGitHubApiService: MockGitHubApiService;

  const TEST_USER_ID = 'maya@example.com';

  beforeEach(() => {
    mockCompleteJson.mockClear();

    mockGitHubApiService = new MockGitHubApiService();
    const localAiHelper = createMockLocalAiHelper(true);
    intentAnalysisService = new IntentAnalysisService(mockGitHubApiService as any, localAiHelper);
    suggestionsService = new SuggestionsService(mockGitHubApiService as any, localAiHelper);
  });

  it("should handle Maya's complete assistance workflow: suggestions → intent → action routing", async () => {
    /**
     * SCENARIO: Maya's complete workflow using the home page
     *
     * Step 1: Maya opens home page and sees AI-powered suggestions
     * Step 2: Maya types a message about creating a new app
     * Step 3: IntentAnalysisService detects 'new-repo' intent
     * Step 4: Maya types about fixing a bug - detects 'existing-repo' intent
     * Step 5: Maya asks a simple question - detects 'simple-task' intent
     */
    const mockRequest = { session: { userEmail: TEST_USER_ID } } as any;

    // === STEP 1: Get suggestions for Maya's open tasks ===
    console.log('📋 Step 1: Maya sees suggestions based on her tasks...');

    const suggestionsParams = {
      message: '',
      framework: null,
      userId: TEST_USER_ID,
      view: 'my',
      req: mockRequest,
    };

    const suggestions = await suggestionsService.generateSuggestions(suggestionsParams);

    expect(suggestions.suggestions.length).toBeGreaterThan(0);
    expect(suggestions.suggestions[0].name).toBe('Fix login bug');
    expect(suggestions.suggestions[0].repo?.owner).toBe('testowner');
    expect(mockCompleteJson).toHaveBeenCalledTimes(1);

    // === STEP 2 & 3: Maya types about creating a new app ===
    console.log('🆕 Step 2-3: Maya wants to create a new app...');

    const newAppAnalysis = await intentAnalysisService.analyzeIntent(
      mockRequest,
      'I want to create a new task management app',
      { currentPage: 'home' }
    );

    expect(newAppAnalysis.intentType).toBe('new-repo');
    expect(newAppAnalysis.suggestedName).toBeDefined();
    expect(newAppAnalysis.suggestedName).toMatch(/^[a-z0-9-]+$/); // kebab-case
    expect(newAppAnalysis.confidence).toBeGreaterThan(0.8);

    // === STEP 4: Maya types about fixing a bug ===
    console.log('🐛 Step 4: Maya wants to fix a bug in existing repo...');

    const bugFixAnalysis = await intentAnalysisService.analyzeIntent(
      mockRequest,
      'fix the login bug in the authentication module',
      { currentRepo: 'testowner/testrepo' }
    );

    expect(bugFixAnalysis.intentType).toBe('existing-repo');
    expect(bugFixAnalysis.useExistingRepo).toBeDefined();
    expect(bugFixAnalysis.useExistingRepo?.owner).toBe('testowner');
    expect(bugFixAnalysis.useExistingRepo?.repo).toBe('testrepo');

    // === STEP 5: Maya asks a simple question ===
    console.log('❓ Step 5: Maya asks a simple question...');

    const questionAnalysis = await intentAnalysisService.analyzeIntent(
      mockRequest,
      'What is the difference between let and const?',
      {}
    );

    expect(questionAnalysis.intentType).toBe('simple-task');
    expect(questionAnalysis.suggestedName).toBeDefined();

    // Verify all four local AI calls were made (1 suggestions + 3 intents)
    expect(mockCompleteJson).toHaveBeenCalledTimes(4);

    console.log("✅ Maya's assistance workflow completed successfully");
  });

  it('should degrade gracefully when no local Anthropic credential is configured', async () => {
    /**
     * SCENARIO: Local-first — the PC has no Anthropic credential configured yet.
     * Neither service throws: intent analysis falls back to a safe heuristic
     * (simple-task + derived name) so the new-chat flow never hard-fails, and
     * suggestions degrade to an empty list.
     */
    const unavailableHelper = createMockLocalAiHelper(false);
    const intentNoCred = new IntentAnalysisService(mockGitHubApiService as any, unavailableHelper);
    const suggestionsNoCred = new SuggestionsService(
      mockGitHubApiService as any,
      unavailableHelper
    );

    const mockRequest = { session: { userEmail: TEST_USER_ID } } as any;

    // Intent analysis falls back to a safe simple-task with a derived kebab-case name
    const analysis = await intentNoCred.analyzeIntent(mockRequest, 'Create a clock app for me', {});
    expect(analysis.intentType).toBe('simple-task');
    expect(analysis.suggestedName).toBeDefined();
    expect(analysis.suggestedName).toMatch(/^[a-z0-9-]+$/);
    // The AI was never called (no credential)
    expect(mockCompleteJson).not.toHaveBeenCalled();

    // Suggestions degrade to an empty list (no throw)
    const suggestions = await suggestionsNoCred.generateSuggestions({
      message: '',
      framework: null,
      userId: TEST_USER_ID,
      view: 'my',
      req: mockRequest,
    });
    expect(suggestions.suggestions).toEqual([]);

    console.log('✅ Graceful degradation verified - no credential produces fallbacks, not errors');
  });
});
