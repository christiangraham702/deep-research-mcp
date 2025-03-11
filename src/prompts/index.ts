/**
 * DEEP RESEARCH PROMPTS MANAGER
 * 
 * This file centralizes all prompts used throughout the Deep Research system.
 * Each prompt is documented with:
 * - What it does
 * - When it's used
 * - Expected inputs and outputs
 * - Optimization notes
 * 
 * Prompts can be easily modified here without hunting through the codebase.
 * All prompts support dynamic variables via ${variable} syntax.
 */

// Global debugging flag - set to true to log prompts before sending to LLMs
export const DEBUG_PROMPTS = false;

/**
 * Logs prompt information when debugging is enabled
 */
export const logPrompt = (promptName: string, model: string, promptText: string) => {
  if (DEBUG_PROMPTS) {
    console.log(`\n=== PROMPT: ${promptName} (${model}) ===`);
    console.log(promptText);
    console.log("=== END PROMPT ===\n");
  }
};

/**
 * Base system prompt that sets the AI's role and guidelines
 * Used as the system message for all LLM calls
 */
export const systemPrompt = () => {
  const now = new Date().toISOString();
  return `You are an expert researcher specializing in news analysis and current events. Today is ${now}. Follow these principles:

TRUTH-SEEKING:
- Prioritize accuracy and factual correctness above all else
- Clearly distinguish between verified facts, reported claims, and speculation
- Present multiple perspectives on controversial topics without bias
- Acknowledge limitations in available information
- Be transparent about sources and their potential biases

UNBIASED REPORTING:
- Present information neutrally without inserting personal opinions
- Give fair representation to competing viewpoints
- Avoid loaded language and emotionally charged terms
- Focus on primary sources and direct evidence when available
- Maintain skepticism toward extraordinary claims lacking strong evidence

NEWS RESEARCH PRINCIPLES:
- Prioritize recency for current events research
- Value information from reputable news sources with editorial oversight
- Consider source reliability and potential motivations
- Be cautious with single-source claims
- Note when information is rapidly evolving or uncertain
- Provide context for developments (historical background, implications)
- Highlight conflicting reports and inconsistencies

RESPONSE FORMAT:
- Be highly organized and information-dense
- Present facts chronologically when useful
- Use concise, clear language optimized for comprehension
- Provide detailed context when necessary
- Flag speculation and predictions clearly
- Segment information by subtopic when dealing with complex subjects
- Highlight the most significant developments prominently

You may be asked to research subjects beyond your knowledge cutoff - assume the user has accurate information about recent events and focus on organizing and analyzing the research materials provided.`;
};

/**
 * SERP Query Generation Prompt
 * 
 * Purpose: Generates search queries to explore a research topic
 * When used: At the beginning of research and for follow-up explorations
 * Input: Main query, optional weighted learnings and research directions
 * Output: List of specific search queries to run
 * 
 * Optimization notes:
 * - Top weighted learnings are used for context (limited to save tokens)
 * - Research directions are prioritized to focus on most important paths
 */
export const generateQueriesPrompt = ({
  query,
  numQueries,
  weightedLearnings = [],
  topDirections = []
}: {
  query: string;
  numQueries: number;
  weightedLearnings?: Array<{ content: string; reliability: number }>;
  topDirections?: Array<{ question: string; priority: number }>;
}) => {
  // Limit the learnings to save tokens
  const limitedLearnings = weightedLearnings.slice(0, 10);
  
  return `Generate ${numQueries} search queries to research this topic: "${query}"

${limitedLearnings.length > 0 
  ? `Recent findings (reliability score shown):
${limitedLearnings.map(l => `[${l.reliability.toFixed(2)}] ${l.content}`).join('\n').substring(0, 1000)}

Focus on: verifying less reliable information and exploring reliable information further.`
  : ''}

${topDirections.length > 0 
  ? `\nPriority research directions:
${topDirections
  .map(d => `[${d.priority}] ${d.question}`)
  .join('\n')}

Address these research directions in your queries.`
  : ''}`;
};

/**
 * Source Reliability Evaluation Prompt
 * 
 * Purpose: Evaluates how reliable a source domain is for the research topic
 * When used: When processing search results to weight information by source quality
 * Input: Domain name and research context
 * Output: Reliability score (0-1) and reasoning
 * 
 * Optimization notes:
 * - Common domains are evaluated with rules rather than LLM calls
 * - Results are cached to avoid re-evaluating the same domains
 */
export const sourceReliabilityPrompt = (domain: string, context: string) => {
  return `Evaluate the reliability of the following source domain for news research about: "${context}"

Domain: ${domain}

For news and current events research, consider factors like:
1. Editorial standards and fact-checking processes
2. Timeliness and currency of information
3. Domain expertise in the subject matter
4. Reputation for accuracy and balanced reporting
5. Transparency about sources and methodologies
6. Commercial biases or conflicts of interest
7. Professional credentials of authors/organization
8. Track record in reporting on this subject`;
};

/**
 * Content Analysis Prompt
 * 
 * Purpose: Analyzes content from search results to extract learnings and follow-up questions
 * When used: After retrieving and reliability-filtering search results
 * Input: Search query, content from sources with reliability metadata
 * Output: Learnings, follow-up questions, and conflicting claims
 * 
 * Optimization notes:
 * - Long content is truncated to 3000 chars to save tokens
 * - Content is formatted with reliability scores to prioritize better sources
 * - Optional research goal focuses the analysis on relevant information
 */
export const contentAnalysisPrompt = ({
  query,
  numLearnings,
  combinedContentFormat,
  researchGoal = ''
}: {
  query: string;
  numLearnings: number;
  combinedContentFormat: string;
  researchGoal?: string;
}) => {
  return `Given the following contents from a SERP search for the query <query>${query}</query>, analyze the information and generate:

1. A list of key learnings from the contents
2. Follow-up questions to research further
3. Identification of any conflicting claims or different perspectives on the same topics

Be fact-focused and unbiased in your analysis. Maintain neutrality and avoid inserting personal opinions or biases. Your goal is to present information accurately, noting differences in reporting or claims across sources.

Return a maximum of ${numLearnings} learnings, ensuring each is unique and information-dense. Include exact metrics, numbers, dates, and entities when available.

IMPORTANT: Pay special attention to areas where sources disagree. For topics with multiple perspectives, note the different viewpoints and which sources support each perspective. Identify potential biases in different sources.

${researchGoal ? `Research Goal: ${researchGoal}
This research is specifically aimed at: ${researchGoal}. Focus on findings that contribute to this goal.

` : ''}Weight information by source reliability - be more confident in information from highly reliable sources and more cautious about information from less reliable sources. For conflicting information, indicate which perspective comes from more reliable sources.

<contents>${combinedContentFormat}</contents>`;
};

/**
 * Final Report Generation Prompt
 * 
 * Purpose: Creates the final research report based on all gathered information
 * When used: After completing all research iterations
 * Input: Original query, all learnings, and conflicting claims
 * Output: Formatted report with timeline, key takeaways, and source analysis
 * 
 * Optimization notes:
 * - Limited to most important learnings (max 40) to save tokens
 * - Only includes top conflicting claims (limited to 5)
 * - Timeline format optimized for readability and quick consumption
 */
export const finalReportPrompt = ({
  prompt, 
  learningsString, 
  conflictingClaimsString
}: {
  prompt: string;
  learningsString: string;
  conflictingClaimsString: string;
}) => {
  return `Given the following prompt from the user, create a CONCISE news summary in a timeline format. This should be optimized for speed reading (maximum 15 minutes to read).

<prompt>${prompt}</prompt>

Here are important learnings from research:

<learnings>\n${learningsString}\n</learnings>
${conflictingClaimsString}

Format the report as follows:
1. Start with a brief "Key Takeaways" section (3-5 bullet points summarizing the most important findings)
2. Create a chronological timeline of events with dates
3. Organize by subtopics if needed (maximum 3-4 subtopics)
4. For each timeline entry, include:
   - Date (exact when available, approximate otherwise)
   - Event description
   - Source attribution (when relevant)
5. Add a "Perspectives" section for topics with significant disagreement
6. End with a "Sources Overview" section evaluating the reliability of major sources

The final report should be balanced, fact-focused, and highlight areas of consensus and disagreement across sources. Aim for a comprehensive but concise summary optimized for quick understanding of the topic.`;
};

/**
 * Follow-up Questions Prompt
 * 
 * Purpose: Generates questions to clarify research direction
 * When used: At the beginning of research to refine the query
 * Input: Original user query
 * Output: Clarifying questions to narrow research focus
 */
export const followUpQuestionsPrompt = (query: string, numQuestions: number) => {
  return `Given the following query from the user, ask some follow up questions to clarify the research direction. Return a maximum of ${numQuestions} questions, but feel free to return less if the original query is already specific and clear.

Query: "${query}"

Ask questions that would help you better understand:
1. The specific aspects of the topic the user is interested in
2. The time period they want to focus on
3. Any specific sources or perspectives they want included
4. The level of technical detail they're looking for
5. How they intend to use the research (for background knowledge, decision-making, etc.)

Return the questions in a clear, numbered format.`;
};

export default {
  systemPrompt,
  generateQueriesPrompt,
  sourceReliabilityPrompt,
  contentAnalysisPrompt,
  finalReportPrompt,
  followUpQuestionsPrompt,
  logPrompt
}; 