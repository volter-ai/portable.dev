/**
 * The AI-action chat prompts/titles for the issue/PR viewers
 * (Start issue chat / Quick fix / Review with AI / Quick Merge) — do not
 * reword lightly.
 */

export interface IssuePromptInput {
  number: number;
  title: string;
  body?: string | null;
  owner: string;
  repo: string;
}

export interface PullPromptInput {
  number: number;
  title: string;
  owner: string;
  repo: string;
  headRef: string;
  baseRef: string;
}

export function issueChatTitle(input: IssuePromptInput): string {
  return `Issue #${input.number}: ${input.title.slice(0, 30)}...`;
}

export function issueChatPrompt(input: IssuePromptInput): string {
  return `I'd like to discuss issue #${input.number} in ${input.owner}/${input.repo}: "${input.title}"

${input.body ? `Issue description:\n${input.body}\n\n` : ''}Let's explore this issue together. What would you like to know about it?`;
}

export function quickFixTitle(input: IssuePromptInput): string {
  return `Fix issue #${input.number}`;
}

export function quickFixPrompt(input: IssuePromptInput): string {
  return `Please help me fix issue #${input.number} in ${input.owner}/${input.repo}: "${input.title}"

Follow this workflow:
1. First, check out a new branch for this fix. Use conventional branch naming with the issue number and a brief description, for example:
   - \`fix/${input.number}-authentication-bug\`
   - \`feat/${input.number}-user-validation\`
   - \`chore/${input.number}-update-dependencies\`
2. Analyze the issue and implement the fix
3. Test the changes to ensure they work correctly
4. Once the fix is ready and working, ask me whether I want to:
   - Create a Pull Request for review
   - Merge directly to the main branch

Please proceed with checking out a branch and implementing the fix.`;
}

export function reviewPrTitle(input: PullPromptInput): string {
  return `Review PR #${input.number}`;
}

export function reviewPrPrompt(input: PullPromptInput): string {
  return `Please help me review pull request #${input.number} in ${input.owner}/${input.repo}: "${input.title}"

Follow this workflow:
1. First, check out the PR branch: ${input.headRef}
2. Review the code changes thoroughly:
   - Check for code quality issues
   - Look for potential bugs or security concerns
   - Verify functionality and logic
   - Check for proper error handling
   - Review test coverage
3. Run any existing tests to ensure they pass
4. Test the changes manually if needed
5. Provide a summary of your findings including:
   - What the PR does
   - Any issues or concerns found
   - Suggestions for improvements
6. Once the review is complete, ask me whether I want to:
   - Request changes (list what needs to be fixed)
   - Approve and merge the PR
   - Approve but don't merge (let author merge)
   - Close the PR without merging

Please be thorough in your review and provide constructive feedback.`;
}

export function quickMergeTitle(input: PullPromptInput): string {
  return `Merge PR #${input.number}`;
}

export function quickMergePrompt(input: PullPromptInput): string {
  return `Please help me merge pull request #${input.number} in ${input.owner}/${input.repo}: "${input.title}"

1. Check out the PR branch: ${input.headRef}
2. Run any tests to ensure everything passes
3. If all checks pass, merge the PR into ${input.baseRef}
4. Delete the feature branch after merge
5. Let me know the result`;
}
