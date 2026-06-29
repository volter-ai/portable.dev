/**
 * Project creation prompts for different frameworks
 * Used when creating new projects from the NewProjectPage
 */

export interface ProjectCreationParams {
  framework: string | null;
  projectName: string | null;
  description: string;
}

/**
 * Generate a project creation prompt based on user selections
 */
export function generateProjectCreationPrompt({
  framework,
  projectName,
  description,
}: ProjectCreationParams): string {
  // For empty projects, provide basic info about the setup
  if (framework === 'empty') {
    return `You are already in the project directory. Empty project setup is COMPLETE:
✅ package.json created with "serve" script (serves public/ folder)
✅ public/ directory created for static files
✅ .gitignore created (.env* files are ignored)
✅ README.md created with instructions
✅ Git initialized with remote configured
✅ Initial commit created and pushed to GitHub

The current directory IS the project root. Do NOT create any nested directories or additional project structure.
Run \`npm run serve\` to start a local server on http://localhost:3000
Add your files to the \`public/\` directory.

User request: ${description}

If the user's request is clear and specific, start implementing it immediately.
If the user's request is vague or just asks to create a project, ASK them what they want to build instead of making assumptions.`;
  }

  // For boilerplate frameworks (Bun)
  // Backend has already done all the setup, AI just needs to implement features
  if (framework === 'bun') {
    const frameworkName = 'Bun';
    return `The ${frameworkName} boilerplate is already fully set up:
✅ Boilerplate files copied to current directory
✅ Dependencies installed (bun install completed)
✅ Git initialized with remote configured
✅ Initial commit created and pushed to GitHub

Read CLAUDE.md to understand the project structure and conventions.

Build this: ${description}

Commit and push your changes when done.`;
  }

  // Generic prompt for frameworks without boilerplate
  // Backend created empty repo, AI needs to initialize and set up
  return `Framework: ${framework || '[choose best framework]'}
Project name: ${projectName || '[choose appropriate name]'}

GitHub repo created (empty). Initialize the project, push initial setup, then build this: ${description}`;
}
