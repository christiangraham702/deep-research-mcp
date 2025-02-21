import { resolve } from 'path';
import { fileURLToPath } from 'url';
import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject } from 'ai';
import { config } from 'dotenv';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { o3MiniModel, trimPrompt } from './ai/providers.js';
import { firecrawl as firecrawlConfig } from './config.js';
import { OutputManager } from './output-manager.js';
import { systemPrompt } from './prompt.js';

// Get the directory name of the current module
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load environment variables from .env.local
config({ path: resolve(__dirname, '../.env.local') });

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  parentQuery?: string; // Track parent query for showing relationships
  totalQueries: number;
  completedQueries: number;
  learningsCount?: number; // Track learnings for this branch
  learnings?: string[]; // The actual learnings content
  followUpQuestions?: string[]; // Follow-up questions generated
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

type SourceMetadata = {
  url: string;
  title?: string;
  publishDate?: string;
  domain: string;
  relevanceScore?: number;
  reliabilityScore: number;
  reliabilityReasoning: string;
};

// Configurable concurrency limit
const ConcurrencyLimit = firecrawlConfig.concurrency;

// Initialize Firecrawl with config
const firecrawl = new FirecrawlApp({
  apiKey: firecrawlConfig.apiKey,
  apiUrl: firecrawlConfig.baseUrl,
});

type LearningWithReliability = {
  content: string;
  reliability: number;
};

async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
  learningReliabilities,
}: {
  query: string;
  numQueries?: number;
  learnings?: string[];
  learningReliabilities?: number[];
}) {
  // Convert to properly typed weighted learnings
  const weightedLearnings: LearningWithReliability[] = learnings && learningReliabilities 
    ? learnings.map((content, i) => ({
        content,
        reliability: learningReliabilities[i] || 0.5
      }))
    : [];

  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other.

${weightedLearnings.length > 0 
  ? `Here are previous learnings with their reliability scores (higher score means more reliable):
${weightedLearnings.map(l => `[Reliability: ${l.reliability.toFixed(2)}] ${l.content}`).join('\n')}

When generating new queries, prioritize following up on information from more reliable sources (reliability >= 0.7). Be more skeptical of and seek verification for information from less reliable sources (reliability < 0.7). For very low reliability sources (reliability < 0.3), generate queries to find more authoritative sources on the same topics.`
  : ''}

<prompt>${query}</prompt>`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('The SERP query'),
            researchGoal: z
              .string()
              .describe(
                'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
              ),
            reliabilityThreshold: z
              .number()
              .describe('Minimum reliability score (between 0 and 1) needed for sources to be considered trustworthy for this query'),
            isVerificationQuery: z
              .boolean()
              .describe('Whether this query is specifically trying to verify information from less reliable sources')
          }),
        )
        .describe(`List of SERP queries, max of ${numQueries}`),
    }),
  });

  // Log more detailed information about query generation
  const verificationQueries = res.object.queries.filter(q => q.isVerificationQuery);
  if (verificationQueries.length > 0) {
    log(`Generated ${verificationQueries.length} verification queries to check information from less reliable sources`);
  }

  return res.object.queries;
}

async function evaluateSourceReliability(domain: string, context: string): Promise<{
  score: number;
  reasoning: string;
}> {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Evaluate the reliability of the following source domain for research about: "${context}"

Domain: ${domain}

Consider factors like:
1. Editorial standards and fact-checking processes
2. Domain expertise in the subject matter
3. Reputation for accuracy and objectivity
4. Transparency about sources and methodology
5. Professional vs user-generated content
6. Commercial biases or conflicts of interest
7. Academic or professional credentials
8. Track record in the field

Return a reliability score between 0 and 1, where:
- 0.9-1.0: Highest reliability (e.g. peer-reviewed journals, primary sources)
- 0.7-0.89: Very reliable (e.g. respected news organizations)
- 0.5-0.69: Moderately reliable (e.g. industry blogs with editorial oversight)
- 0.3-0.49: Limited reliability (e.g. personal blogs, commercial sites)
- 0-0.29: Low reliability (e.g. known misinformation sources)`,
    schema: z.object({
      score: z.number().describe('Reliability score between 0 and 1'),
      reasoning: z.string().describe('Brief explanation of the reliability assessment'),
      domainExpertise: z.string().describe('Assessment of domain expertise in this specific topic')
    })
  });

  return {
    score: res.object.score,
    reasoning: res.object.reasoning
  };
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}): Promise<{
  learnings: string[];
  learningConfidences: number[];
  followUpQuestions: string[];
  followUpPriorities: number[];
  sourceMetadata: SourceMetadata[];
  weightedLearnings: LearningWithReliability[];
}> {
  const contents = compact(result.data.map(item => item.markdown)).map(
    content => trimPrompt(content, 25_000),
  );

  // Evaluate source reliability for each domain
  const sourceMetadataPromises = compact(result.data.map(async item => {
    if (!item.url) return null;
    try {
      const domain = new URL(item.url).hostname;
      const reliability = await evaluateSourceReliability(domain, query);
      return {
        url: item.url,
        title: item.title || undefined,
        publishDate: undefined,
        domain,
        relevanceScore: undefined,
        reliabilityScore: reliability.score,
        reliabilityReasoning: reliability.reasoning
      } as SourceMetadata;
    } catch (e) {
      return null;
    }
  }));

  const sourceMetadata = compact(await Promise.all(sourceMetadataPromises));

  // Sort and filter contents by reliability
  const contentWithMetadata = contents
    .map((content, i) => ({
      content,
      metadata: sourceMetadata[i]
    }))
    .filter((item): item is { content: string; metadata: SourceMetadata } => !!item.metadata);

  // Sort by reliability and filter out very unreliable sources
  const sortedContents = contentWithMetadata
    .sort((a, b) => b.metadata.reliabilityScore - a.metadata.reliabilityScore)
    .filter(item => item.metadata.reliabilityScore >= 0.3) // Filter out very unreliable sources
    .map(item => item.content);

  log(`Ran ${query}, found ${contents.length} contents (${sourceMetadata.filter(m => m.reliabilityScore >= 0.7).length} from highly reliable sources)`);

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates.

Weight information by source reliability - be more confident in information from highly reliable sources and more cautious about information from less reliable sources. If possible, try to verify information from less reliable sources against more reliable ones.

<contents>${contentWithMetadata
      .map(({ content, metadata }) => 
        `<content reliability="${metadata.reliabilityScore.toFixed(2)}" reasoning="${metadata.reliabilityReasoning}" source="${metadata.domain}">\n${content}\n</content>`
      )
      .join('\n')}</contents>`,
    schema: z.object({
      learnings: z
        .array(z.object({
          content: z.string(),
          confidence: z.number().describe('Confidence in this learning based on source reliability (between 0 and 1)'),
          sources: z.array(z.string()).describe('List of source domains that support this learning')
        }))
        .describe(`List of learnings, max of ${numLearnings}`),
      followUpQuestions: z
        .array(z.object({
          question: z.string(),
          priority: z.number().describe('Priority of this question (1-5) based on current source reliability gaps'),
          reason: z.string().describe('Why this follow-up is needed, especially regarding source reliability')
        }))
        .describe('Follow-up questions to research, prioritized by reliability gaps'),
      sourceQuality: z.object({
        mostReliableSources: z.array(z.string()),
        contentGaps: z.array(z.string()),
        reliabilityAnalysis: z.string()
      })
    }),
  });

  // Create properly typed weighted learnings
  const weightedLearnings: LearningWithReliability[] = res.object.learnings.map(l => ({
    content: l.content,
    reliability: l.confidence
  }));

  return {
    ...res.object,
    sourceMetadata,
    learnings: weightedLearnings.map(l => l.content),
    learningConfidences: weightedLearnings.map(l => l.reliability),
    followUpQuestions: res.object.followUpQuestions.map(q => q.question),
    followUpPriorities: res.object.followUpQuestions.map(q => q.priority),
    weightedLearnings
  };
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
  sourceMetadata,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  sourceMetadata: SourceMetadata[];
}) {
  log('Starting to generate final report...');
  log(`Processing ${learnings.length} learnings and ${visitedUrls.length} sources...`);
  
  // Analyze source reliability distribution
  const reliabilityGroups = {
    high: sourceMetadata.filter(m => m.reliabilityScore >= 0.8),
    medium: sourceMetadata.filter(m => m.reliabilityScore >= 0.5 && m.reliabilityScore < 0.8),
    low: sourceMetadata.filter(m => m.reliabilityScore < 0.5)
  };

  const sourceAnalysis = `
### Source Reliability Distribution
- High Reliability Sources (0.8-1.0): ${reliabilityGroups.high.length} sources
- Medium Reliability Sources (0.5-0.79): ${reliabilityGroups.medium.length} sources
- Lower Reliability Sources (<0.5): ${reliabilityGroups.low.length} sources

### Source Quality Analysis
${sourceMetadata.length > 0 
  ? `Overall source quality is ${getOverallQualityAssessment(reliabilityGroups)}. 
${reliabilityGroups.high.length > 0 
  ? `The research benefits from ${reliabilityGroups.high.length} highly reliable sources, providing strong foundation for the findings.` 
  : 'Note: No highly reliable sources were found for this topic, which may affect the confidence in some findings.'}`
  : 'No source quality data available.'}`;

  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );

  log('Generating comprehensive report structure and content...');
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, write a final report on the topic using the learnings from research. The report should:
1. Be highly detailed (aim for 3+ pages)
2. Include ALL the learnings from research, prioritizing those from highly reliable sources
3. Have a clear structure with sections and subsections
4. Include an executive summary at the start
5. Maintain academic rigor with proper source citations (including reliability scores)
6. End with conclusions and implications
7. Include a methodology section explaining how the research was conducted
8. Consider source reliability in the confidence of conclusions

<prompt>${prompt}</prompt>

Here are all the learnings from previous research:

<learnings>\n${learningsString}\n</learnings>`,
    schema: z.object({
      reportMarkdown: z.string().describe('Final report on the topic in Markdown'),
      executiveSummary: z.string().describe('A concise summary of the key findings'),
      keyFindings: z.array(z.object({
        finding: z.string(),
        confidence: z.enum(['High', 'Medium', 'Low']).describe('Confidence level based on source reliability'),
      })).describe('List of the most important findings with confidence levels'),
      researchGaps: z.array(z.string()).describe('Areas that could benefit from further research'),
      methodology: z.string().describe('Description of the research methodology used'),
      confidenceAssessment: z.string().describe('Overall assessment of confidence in findings based on source quality')
    }),
  });

  log('Finalizing report with source citations and metadata...');
  
  // Create the final report structure
  const finalReport = [
    '# ' + prompt.split('\n')[0], // Use first line of prompt as title
    '\n## Executive Summary\n',
    res.object.executiveSummary,
    '\n## Key Findings\n',
    res.object.keyFindings.map(finding => `- ${finding.finding} _(Confidence: ${finding.confidence})_`).join('\n'),
    '\n## Methodology\n',
    res.object.methodology,
    '\n## Detailed Analysis\n',
    res.object.reportMarkdown,
    '\n## Research Gaps and Future Directions\n',
    res.object.researchGaps.map(gap => `- ${gap}`).join('\n'),
    '\n## Source Analysis and Quality Assessment\n',
    sourceAnalysis,
    res.object.confidenceAssessment,
    '\n## Sources\n',
    sourceMetadata
      .sort((a, b) => b.reliabilityScore - a.reliabilityScore)
      .map(metadata => 
        `- ${metadata.domain} (Reliability Score: ${metadata.reliabilityScore.toFixed(2)})
  - ${metadata.url}
  - ${metadata.reliabilityReasoning}`
      )
      .join('\n'),
    '\n\n*Report generated on: ' + new Date().toISOString() + '*'
  ].join('\n');

  log('Report generation complete!');
  return finalReport;
}

function getOverallQualityAssessment(groups: { 
  high: SourceMetadata[], 
  medium: SourceMetadata[], 
  low: SourceMetadata[] 
}): string {
  const total = groups.high.length + groups.medium.length + groups.low.length;
  const highPercentage = (groups.high.length / total) * 100;
  const mediumPercentage = (groups.medium.length / total) * 100;

  if (highPercentage >= 60) return "excellent";
  if (highPercentage >= 40 || (highPercentage + mediumPercentage) >= 70) return "good";
  if (highPercentage >= 20 || (highPercentage + mediumPercentage) >= 50) return "fair";
  return "limited";
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  learningReliabilities = [],
  visitedUrls = [],
  weightedLearnings = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  learningReliabilities?: number[];
  visitedUrls?: string[];
  weightedLearnings?: LearningWithReliability[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<{
  learnings: string[];
  learningReliabilities: number[];
  visitedUrls: string[];
  sourceMetadata: SourceMetadata[];
  weightedLearnings: LearningWithReliability[];
}> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };

  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    learningReliabilities,
    numQueries: breadth,
  });

  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query,
  });

  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await firecrawl.search(serpQuery.query, {
            timeout: 15000,
            limit: 5,
            scrapeOptions: { formats: ['markdown'] },
          });

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const processedResult = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          
          const allLearnings = [...learnings, ...processedResult.learnings];
          const allUrls = [...visitedUrls, ...newUrls];
          const allSourceMetadata = [...(processedResult.sourceMetadata || [])];
          const allWeightedLearnings = [...weightedLearnings, ...processedResult.weightedLearnings];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
              parentQuery: query,
              learningsCount: processedResult.learnings.length,
              learnings: processedResult.learnings,
              followUpQuestions: processedResult.followUpQuestions,
            });

            const nextQuery = `
Previous research goal: ${serpQuery.researchGoal}
Follow-up research directions: ${processedResult.followUpQuestions.map(q => `\n${q}`).join('')}
`.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              learningReliabilities: processedResult.learningConfidences,
              visitedUrls: allUrls,
              weightedLearnings: allWeightedLearnings,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              learningReliabilities: processedResult.learningConfidences,
              visitedUrls: allUrls,
              sourceMetadata: allSourceMetadata,
              weightedLearnings: allWeightedLearnings
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(`Timeout error running query: ${serpQuery.query}: `, e);
          } else {
            log(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            learningReliabilities: [],
            visitedUrls: [],
            sourceMetadata: [],
            weightedLearnings: []
          };
        }
      }),
    ),
  );

  const combinedResults = {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    learningReliabilities: [...new Set(results.flatMap(r => r.learningReliabilities))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
    sourceMetadata: [...new Set(results.flatMap(r => r.sourceMetadata))],
    weightedLearnings: [...new Set(results.flatMap(r => r.weightedLearnings))]
  };

  return combinedResults;
}
