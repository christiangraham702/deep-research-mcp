import { generateObject } from 'ai';
import { z } from 'zod';

import { o3MiniModel } from './ai/providers.js';
import prompts from './prompts/index.js';
import debug from './utils/debug.js';

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}) {
  // Generate the prompt using our centralized prompt manager
  const promptText = prompts.followUpQuestionsPrompt(query, numQuestions);
  
  // Log the prompt if debugging is enabled
  prompts.logPrompt('Follow-up Questions', o3MiniModel.toString(), promptText);
  
  // Start a timer for performance tracking
  const timer = debug.timer('Generate Follow-up Questions');

  const userFeedback = await generateObject({
    model: o3MiniModel,
    system: prompts.systemPrompt(),
    prompt: promptText,
    schema: z.object({
      questions: z
        .array(z.string())
        .describe(
          `Follow up questions to clarify the research direction`
        ),
    }),
  });

  // End timer
  timer.end();
  debug.debug(`Generated ${userFeedback.object.questions.length} follow-up questions`);

  return userFeedback.object.questions.slice(0, numQuestions);
}
