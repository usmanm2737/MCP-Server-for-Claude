import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

const resumeProjectArgsSchema = z.object({
  projectName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'The project to resume. If omitted, ask the user which project before doing anything else.',
    ),
});

/** Registers the `resume_project` prompt: a reusable "pick up where I left off" workflow. */
export function registerResumeProjectPrompt(server: McpServer): void {
  server.registerPrompt(
    'resume_project',
    {
      title: 'Resume Project',
      description:
        'Guides the client through resuming work on a project using saved memory: load state, review ' +
        'decisions/blockers/tasks, summarize, and propose the next action.',
      argsSchema: resumeProjectArgsSchema,
    },
    ({ projectName }) => {
      const target = projectName ?? '{ask the user which project}';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `I want to resume work on project "${target}". Using the claude-activity-memory MCP tools:`,
                '',
                `1. Call get_project_context with projectName="${target}" to load its saved state, recent ` +
                  'activity, decisions, and open/blocked tasks. If the project does not exist, say so and stop ' +
                  '— do not create it just to read from it.',
                '2. Identify what has already been completed and which decisions were made, and why (use the ' +
                  'decisions’ rationale, not just their titles).',
                '3. Review blocked and open tasks; call out anything blocked first.',
                '4. If the loaded context is thin or seems stale for what I am about to ask, call ' +
                  'search_activity or get_recent_activity for more detail before concluding anything — do not ' +
                  'guess at history that was not actually retrieved.',
                '5. Summarize, in a few sentences, where this project currently stands.',
                '6. Propose the single most useful next action, grounded in the saved next_steps and open tasks.',
                '7. If the saved state is ambiguous, contradictory, or clearly out of date, say so explicitly ' +
                  'and ask me rather than silently picking an interpretation.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}
