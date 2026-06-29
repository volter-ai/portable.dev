/**
 * Default Standard Operating Procedure for Best Practice Agent
 *
 * This is used when no custom SOP is found in the repository's .volter/sop.md file.
 */
export const DEFAULT_SOP = `# Standard Operating Procedure - Best Practice Agent

## Steps to Follow

1. **Link chat to GitHub issue**
   1.1 [ ] Check for existing issues matching the request
   1.2 [ ] Create new issue if none exist
   1.3 [ ] Link issue to chat using mcp__standard__link_issue_to_chat
   1.4 [ ] Ensure issue is assigned to the user

   Issue ID: ___
   Assigned to: ___

2. **Gather context before implementation**
   2.1 [ ] Delegate to context specialist
   2.2 [ ] Collect all relevant files, methods, and context
   2.3 [ ] Understand the specific problem thoroughly

   Completed: ___

3. **Implement code changes**
   3.1 [ ] Delegate to coding specialist with gathered context
   3.2 [ ] Provide all necessary information to coding specialist
   3.3 [ ] Ensure code follows project conventions

   Completed: ___

4. **Test changes (if significant)**
   4.0 [ ] DECISION: Are changes significant enough to warrant testing?
         → If NO: Skip to step 5
         → If YES: Continue with 4.1
   4.1 [ ] Delegate to QA specialist for Playwright testing
   4.2 [ ] Verify functionality works as expected
   4.3 [ ] Check for regressions

   Completed: ___

5. **Code review and commit**
   5.1 [ ] Delegate to code review specialist
   5.2 [ ] Ensure code is safe, clean, and correct
   5.3 [ ] Create commit with proper message
   5.4 [ ] Add comment on GitHub issue linking commit

   Commit SHA: ___

6. **Create PR or merge**
   6.0 [ ] DECISION: Ask user: Create PR or push directly to main?
         → Record user's choice below
   6.1 [ ] Use git specialist to create PR or merge
   6.2 [ ] Ensure PR has linked issue (if PR)
   6.3 [ ] Suggest potential reviewer to user (if PR)
   6.4 [ ] User assigns reviewer (if PR)

   User choice: ___
   PR/Push: ___

7. **Monitor GitHub Actions workflows**
   7.0 [ ] DECISION: Does this repo have GitHub Actions workflows?
         → If NO: Skip to step 8
         → If YES: Continue with 7.1
   7.1 [ ] Identify workflows triggered by this deployment
   7.2 [ ] Use git specialist to monitor until completion
   7.3 [ ] Check status periodically with doubling backoff
   7.4 [ ] Report final status and logs if failed

   Workflow status: ___

8. **Close issue (if ready)**
   8.0 [ ] DECISION: Ask user whether to close the issue
         → If NO: Skip to step 9
         → If YES: Continue with 8.1
   8.1 [ ] Close issue if user confirms

   User choice: ___
   Issue closed: ___

9. **Archive chat**
   9.1 [ ] Inform user that work is complete
   9.2 [ ] Ready to archive chat

   Archived: ___

# Alternate paths
10. **If we determined that this SOP does not apply to the user's request**
   10.1 [ ] Inform user that this SOP does not apply

   Reason (brief): ___
`;
