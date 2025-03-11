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
import prompts from './prompts/index.js';
import debug, { createOpenAISchema } from './utils/debug.js';

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
  sources?: SourceMetadata[]; // Sources found during research
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

// Cache for source reliability scores to reduce LLM calls
const reliabilityCache = new Map<string, {score: number, reasoning: string}>();

// For news research: Calculate date 30 days ago for recent sources
const getDateFromMonthsAgo = (months = 1) => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().split('T')[0]; // Returns YYYY-MM-DD format
};

// News source domains to prioritize for news research
const newsSources = [
  'techcrunch.com',
  'wired.com',
  'arstechnica.com',
  'theverge.com', 
  'zdnet.com',
  'cnn.com',
  'bbc.com',
  'reuters.com',
  'bloomberg.com',
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'ft.com',
  'venturebeat.com',
  'thenextweb.com',
];

// Tech blog domains for AI and tech news
const techBlogs = [
  'openai.com',
  'blog.google',
  'ai.meta.com',
  'ai.facebook.com',
  'microsoft.com/en-us/research',
  'deepmind.com',
  'anthropic.com',
  'huggingface.co',
];

type LearningWithReliability = {
  content: string;
  reliability: number;
};

export type ResearchDirection = {
  question: string;
  priority: number;
  parentGoal?: string;  // Track which research goal led to this question
};

async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
  learningReliabilities,
  researchDirections = [],
}: {
  query: string;
  numQueries?: number;
  learnings?: string[];
  learningReliabilities?: number[];
  researchDirections?: ResearchDirection[];
}) {
  // Convert learnings array with reliability scores to weighted format
  const weightedLearnings = learnings && learningReliabilities ? 
    learnings.map((content, i) => ({ 
      content, 
      reliability: learningReliabilities[i] || 0.5  // Default to 0.5 if undefined
    })).sort((a, b) => (b.reliability || 0) - (a.reliability || 0)) : 
    [];

  // Prioritize research directions
  const topDirections = [...researchDirections].sort((a, b) => b.priority - a.priority).slice(0, 5);

  // Generate the prompt using our centralized prompt manager
  const promptText = prompts.generateQueriesPrompt({
    query,
    numQueries,
    weightedLearnings,
    topDirections
  });

  // Log the prompt if debugging is enabled
  prompts.logPrompt('Generate SERP Queries', o3MiniModel.toString(), promptText);

  // Start a timer for performance tracking
  const timer = debug.timer('Generate SERP Queries');

  const res = await generateObject({
    model: o3MiniModel,
    system: prompts.systemPrompt(),
    prompt: promptText,
    schema: createOpenAISchema(z.object({
      queries: z.array(z.string().max(200)),
    })),
  });

  // End timer and log result if debugging is enabled
  timer.end();
  
  // Add explicit type assertion to handle the unknown type
  const result = res.object as { queries: string[] };
  debug.debug(`Generated ${result.queries.length} search queries`);

  // Limit the number of queries to respect the numQueries parameter
  // Also trim any excessively long queries to 200 characters
  const limitedQueries = result.queries
    .map((query: string) => query.length > 200 ? query.substring(0, 200) : query)
    .slice(0, numQueries);
  
  return limitedQueries;
}

async function evaluateSourceReliability(domain: string, context: string): Promise<{
  score: number;
  reasoning: string;
}> {
  // Check cache first to avoid redundant LLM calls
  if (reliabilityCache.has(domain)) {
    return reliabilityCache.get(domain)!;
  }
  
  // For news sources, adjust reliability scoring
  // Check if domain is a reputable news source
  if (newsSources.some(source => domain.includes(source))) {
    const newsReliability = {
      score: 0.85, // News sources are considered highly reliable for recent events
      reasoning: `${domain} is a recognized news outlet with editorial standards and fact-checking processes, making it a reliable source for current events and news.`
    };
    reliabilityCache.set(domain, newsReliability);
    return newsReliability;
  }
  
  // Check if domain is a tech blog for AI/tech news
  if (techBlogs.some(blog => domain.includes(blog))) {
    const techBlogReliability = {
      score: 0.80, // Tech blogs from major companies are reliable for their own announcements
      reasoning: `${domain} is an official technology blog/site with direct company information, making it a reliable primary source for recent developments and announcements.`
    };
    reliabilityCache.set(domain, techBlogReliability);
    return techBlogReliability;
  }

  // Rule-based reliability for common domains to avoid LLM calls
  if (domain.includes('wikipedia.org')) {
    const wikiReliability = {
      score: 0.75,
      reasoning: `${domain} is a collaborative encyclopedia with editorial oversight, citations, and community review, making it generally reliable for factual information but subject to occasional inaccuracies.`
    };
    reliabilityCache.set(domain, wikiReliability);
    return wikiReliability;
  }
  
  if (domain.includes('github.com') || domain.includes('gitlab.com')) {
    const repoReliability = {
      score: 0.70,
      reasoning: `${domain} is a code repository hosting platform with primary source code and documentation, making it reliable for technical information but varying in quality depending on the specific repository.`
    };
    reliabilityCache.set(domain, repoReliability);
    return repoReliability;
  }
  
  if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
    const videoReliability = {
      score: 0.50,
      reasoning: `${domain} is a video platform with varying content quality and minimal editorial oversight, requiring verification from other sources.`
    };
    reliabilityCache.set(domain, videoReliability);
    return videoReliability;
  }
  
  if (domain.includes('reddit.com')) {
    const redditReliability = {
      score: 0.40,
      reasoning: `${domain} is a social media platform with user-generated content, minimal verification, and varying expertise levels.`
    };
    reliabilityCache.set(domain, redditReliability);
    return redditReliability;
  }

  // For unknown domains, use LLM to evaluate
  const promptText = prompts.sourceReliabilityPrompt(domain, context);
  
  // Log the prompt if debugging is enabled
  prompts.logPrompt('Source Reliability', o3MiniModel.toString(), promptText);
  
  // Start a timer for performance tracking
  const timer = debug.timer(`Reliability Evaluation for ${domain}`);

  const res = await generateObject({
    model: o3MiniModel,
    system: prompts.systemPrompt(),
    prompt: promptText,
    schema: createOpenAISchema(z.object({
      score: z.number().describe('Reliability score between 0 and 1'),
      reasoning: z.string().describe('Brief explanation of the reliability assessment, one or two sentences'),
      domainExpertise: z.string().describe('Assessment of domain expertise in this specific topic')
    }))
  });

  // End timer
  timer.end();
  
  const result = res.object as { score: number; reasoning: string; domainExpertise: string };
  const reliabilityResult = {
    score: result.score,
    reasoning: result.reasoning
  };
  
  // Cache the result for future use
  reliabilityCache.set(domain, reliabilityResult);
  
  return reliabilityResult;
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
  reliabilityThreshold = 0.25, // Lower threshold to include more news sources
  researchGoal = '',
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
  reliabilityThreshold?: number;
  researchGoal?: string;
}): Promise<{
  learnings: string[];
  learningConfidences: number[];
  followUpQuestions: string[];
  followUpPriorities: number[];
  sourceMetadata: SourceMetadata[];
  weightedLearnings: LearningWithReliability[];
  conflictingClaims?: {topic: string, perspectives: {claim: string, sources: string[]}[]}[];
}> {
  // Collect and truncate contents to reduce token usage
  const contents = compact(result.data.map(item => item.markdown)).map(
    content => trimPrompt(content, 15_000), // Reduced from 25,000 to 15,000 tokens
  );

  // Evaluate source reliability for each domain
  const sourceMetadataPromises = compact(result.data.map(async item => {
    if (!item.url) return null;
    try {
      const domain = new URL(item.url).hostname;
      const reliability = await evaluateSourceReliability(domain, query);
      
      // Try to extract publication date from metadata if available
      let publishDate = undefined;
      if (item.metadata && typeof item.metadata === 'object') {
        // Check for common metadata date fields
        const metadata = item.metadata as Record<string, any>;
        publishDate = metadata.publishedTime || 
                     metadata.datePublished || 
                     metadata.publicationDate || 
                     metadata.date || 
                     undefined;
      }
      
      return {
        url: item.url,
        title: item.title || undefined,
        publishDate: publishDate,
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

  // Sort by reliability and filter using the provided threshold
  const sortedContents = contentWithMetadata
    .sort((a, b) => b.metadata.reliabilityScore - a.metadata.reliabilityScore)
    .filter(item => item.metadata.reliabilityScore >= reliabilityThreshold)
    .map(item => item.content);

  log(`Ran query: "${query}"`);
  log(`Found ${contents.length} sources (${sourceMetadata.filter(m => m.reliabilityScore >= reliabilityThreshold).length} above reliability threshold ${reliabilityThreshold})`);
  
  // Log source information
  sourceMetadata.forEach(source => {
    const reliabilityEmoji = source.reliabilityScore >= 0.8 ? "✅" : 
                             source.reliabilityScore >= 0.5 ? "⚠️" : "❌";
    log(`  ${reliabilityEmoji} [${source.reliabilityScore.toFixed(2)}] ${source.url}`);
    if (source.title) {
      log(`    Title: ${source.title}`);
    }
    if (source.publishDate) {
      log(`    Published: ${source.publishDate}`);
    }
  });
  
  // If no valid contents or too few, return empty results to save LLM calls
  if (sortedContents.length === 0) {
    return {
      learnings: [],
      learningConfidences: [],
      followUpQuestions: [],
      followUpPriorities: [],
      sourceMetadata,
      weightedLearnings: [],
      conflictingClaims: []
    };
  }

  // Prepare a more efficient prompt by combining content with metadata
  // This reduces duplication and save tokens in the LLM call
  const combinedContentFormat = contentWithMetadata
    .filter(item => item.metadata.reliabilityScore >= reliabilityThreshold)
    .map(({ content, metadata }) => {
      // Extract a shorter content preview to reduce tokens
      const contentPreview = content.length > 3000 
        ? content.substring(0, 3000) + "... [content truncated]" 
        : content;
      
      return `<content reliability="${metadata.reliabilityScore.toFixed(2)}" source="${metadata.domain}" url="${metadata.url}">\n${contentPreview}\n</content>`;
    })
    .join('\n');

  // Generate the prompt using our centralized prompt manager
  const promptText = prompts.contentAnalysisPrompt({
    query,
    numLearnings,
    combinedContentFormat,
    researchGoal
  });

  // Log the prompt if debugging is enabled
  prompts.logPrompt('Content Analysis', o3MiniModel.toString(), promptText);

  // Start a timer for performance tracking
  const timer = debug.timer('Content Analysis');

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: prompts.systemPrompt(),
    prompt: promptText,
    schema: createOpenAISchema(z.object({
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
        .describe(`Follow-up questions to research, prioritized by reliability gaps`),
      sourceQuality: z.object({
        mostReliableSources: z.array(z.string()),
        contentGaps: z.array(z.string()),
        reliabilityAnalysis: z.string()
      }),
      conflictingClaims: z.array(z.object({
        topic: z.string().describe('The topic where sources present conflicting information'),
        perspectives: z.array(z.object({
          claim: z.string().describe('The specific claim or perspective'),
          sources: z.array(z.string()).describe('Sources supporting this claim/perspective'),
          reliability: z.number().describe('Average reliability score of sources supporting this claim')
        })).describe('Different perspectives on the same topic from different sources')
      })).describe('List of topics where sources provide contradictory or different information')
    })),
  });

  // End timer and log result if debugging is enabled
  timer.end();
  
  // Add explicit type assertion for the result
  type ContentAnalysisResult = {
    learnings: Array<{ content: string; confidence: number; sources: string[] }>;
    followUpQuestions: Array<{ question: string; priority: number; reason: string }>;
    sourceQuality: { mostReliableSources: string[]; contentGaps: string[]; reliabilityAnalysis: string };
    conflictingClaims: Array<{ 
      topic: string; 
      perspectives: Array<{ claim: string; sources: string[]; reliability: number }> 
    }>;
  };
  
  const analysisResult = res.object as ContentAnalysisResult;
  
  debug.debug(`Extracted ${analysisResult.learnings.length} learnings and ${analysisResult.followUpQuestions.length} follow-up questions`);

  // Create properly typed weighted learnings
  const weightedLearnings: LearningWithReliability[] = analysisResult.learnings.map(l => ({
    content: l.content,
    reliability: l.confidence
  }));

  // Ensure we don't exceed the numFollowUpQuestions limit
  const limitedFollowUpQuestions = analysisResult.followUpQuestions.slice(0, numFollowUpQuestions);

  return {
    learnings: weightedLearnings.map(l => l.content),
    learningConfidences: weightedLearnings.map(l => l.reliability),
    followUpQuestions: limitedFollowUpQuestions.map(q => q.question),
    followUpPriorities: limitedFollowUpQuestions.map(q => q.priority),
    sourceMetadata,
    weightedLearnings,
    conflictingClaims: analysisResult.conflictingClaims
  };
}

export async function writeFinalReport({
  prompt,
  learnings,
  sourceMetadata,
  conflictingClaims = [],
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  sourceMetadata: SourceMetadata[];
  conflictingClaims?: {topic: string, perspectives: {claim: string, sources: string[]}[]}[];
}) {
  // Quick reliability analysis
  const reliabilityGroups = {
    high: sourceMetadata.filter(m => m.reliabilityScore >= 0.8),
    medium: sourceMetadata.filter(m => m.reliabilityScore >= 0.5 && m.reliabilityScore < 0.8),
    low: sourceMetadata.filter(m => m.reliabilityScore < 0.5)
  };

  // Limit the number of learnings sent to the final report to reduce token usage
  const maxLearningsForReport = 40; // cap at 40 learnings
  const filteredLearnings = learnings.length > maxLearningsForReport
    ? learnings.slice(0, maxLearningsForReport)
    : learnings;
    
  const learningsString = trimPrompt(
    filteredLearnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    100_000, // reduced from 150k to 100k to save tokens
  );

  // Optimize conflicting claims - only pass the most important ones
  const significantConflictingClaims = conflictingClaims.slice(0, 5); // Only use top 5 conflicts
  
  // Pass conflicting claims to the AI for better reporting
  const conflictingClaimsString = significantConflictingClaims.length > 0 
    ? `\n\n<conflicting_claims>\n${JSON.stringify(significantConflictingClaims, null, 2)}\n</conflicting_claims>`
    : '';

  // Generate the prompt using our centralized prompt manager
  const promptText = prompts.finalReportPrompt({
    prompt,
    learningsString,
    conflictingClaimsString
  });

  // Log the prompt if debugging is enabled
  prompts.logPrompt('Final Report', o3MiniModel.toString(), promptText);

  // Start a timer for performance tracking
  const timer = debug.timer('Final Report Generation');

  // For news research, emphasize the recency of information and make it concise
  const res = await generateObject({
    model: o3MiniModel,
    system: prompts.systemPrompt(),
    prompt: promptText,
    schema: createOpenAISchema(z.object({
      reportMarkdown: z.string().describe('Concise news timeline report in Markdown format'),
      conflictingInformation: z.array(z.object({
        topic: z.string().describe('The specific topic or claim where sources conflict'),
        perspective1: z.object({
          claim: z.string().describe('First perspective or claim'),
          sources: z.array(z.string()).describe('Sources supporting this claim')
        }),
        perspective2: z.object({
          claim: z.string().describe('Second perspective or claim'),
          sources: z.array(z.string()).describe('Sources supporting this claim')
        }),
        analysisOfConflict: z.string().describe('Brief analysis of why these perspectives might differ')
      })).describe('List of topics where sources provide conflicting information or perspectives')
    })),
  });

  // End timer and log result if debugging is enabled
  timer.end();

  // Type assertion for the result
  type FinalReportResult = {
    reportMarkdown: string;
    conflictingInformation: Array<{
      topic: string;
      perspective1: { claim: string; sources: string[] };
      perspective2: { claim: string; sources: string[] };
      analysisOfConflict: string;
    }>;
  };
  
  const reportResult = res.object as FinalReportResult;
  
  debug.debug(`Generated final report with ${reportResult.conflictingInformation?.length || 0} conflict sections`);

  // Generate the conflicting information section
  let conflictingSection = '';
  
  // Combine conflicting information from both sources (AI-detected and collected during research)
  if (reportResult.conflictingInformation && reportResult.conflictingInformation.length > 0) {
    conflictingSection = '\n\n## Conflicting Information\n\n';
    
    // Add AI-detected conflicts
    reportResult.conflictingInformation.forEach(conflict => {
      conflictingSection += `### ${conflict.topic}\n\n`;
      conflictingSection += `**Perspective 1**: ${conflict.perspective1.claim}\n`;
      conflictingSection += `- Sources: ${conflict.perspective1.sources.join(', ')}\n\n`;
      conflictingSection += `**Perspective 2**: ${conflict.perspective2.claim}\n`;
      conflictingSection += `- Sources: ${conflict.perspective2.sources.join(', ')}\n\n`;
      conflictingSection += `**Analysis**: ${conflict.analysisOfConflict}\n\n`;
    });
  }
  
  // Add collected conflicts if not already covered
  if (conflictingClaims.length > 0 && 
      (reportResult.conflictingInformation === undefined || 
       reportResult.conflictingInformation.length === 0)) {
    
    if (conflictingSection === '') {
      conflictingSection = '\n\n## Conflicting Information\n\n';
    }
    
    // Add conflicts collected during research
    conflictingClaims.forEach(conflict => {
      conflictingSection += `### ${conflict.topic}\n\n`;
      
      conflict.perspectives.forEach((perspective, i) => {
        conflictingSection += `**Perspective ${i+1}**: ${perspective.claim}\n`;
        conflictingSection += `- Sources: ${perspective.sources.join(', ')}\n\n`;
      });
    });
  }

  // Add a summary timeline section for news reports
  let timelineSection = '\n\n## News Timeline\n\n';
  const sourcesWithDates = sourceMetadata.filter(s => s.publishDate);
  
  if (sourcesWithDates.length > 0) {
    timelineSection += sourcesWithDates
      .sort((a, b) => new Date(b.publishDate!).getTime() - new Date(a.publishDate!).getTime())
      .map(s => `- **${s.publishDate}**: ${s.title || 'News update'} (${s.domain})`)
      .join('\n');
  } else {
    timelineSection += '_No precise dates available for timeline_';
  }

  // Add a sources section with reliability scores and organized by date if available
  // Limit to top 30 sources to reduce output size
  const topSources = sourceMetadata
    .sort((a, b) => {
      // First try to sort by date if available
      if (a.publishDate && b.publishDate) {
        return new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime(); // Most recent first
      }
      // Fall back to reliability score
      return b.reliabilityScore - a.reliabilityScore;
    })
    .slice(0, 30); // Only include top 30 sources to keep report concise
    
  const sourcesSection = '\n\n## Sources\n\n' + topSources
    .map(metadata => {
      const parts = [
        `- ${metadata.url}`,
        `  - Reliability: ${metadata.reliabilityScore.toFixed(2)} - ${metadata.reliabilityReasoning}`,
      ];
      if (metadata.title) {
        parts.push(`  - Title: ${metadata.title}`);
      }
      if (metadata.publishDate) {
        parts.push(`  - Published: ${metadata.publishDate}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  return reportResult.reportMarkdown + conflictingSection + timelineSection + sourcesSection;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  learningReliabilities = [],
  visitedUrls = [],
  weightedLearnings = [],
  researchDirections = [],  // Add structured research directions
  conflictingClaims = [],  // Track conflicting claims throughout research
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  learningReliabilities?: number[];
  visitedUrls?: string[];
  weightedLearnings?: LearningWithReliability[];
  researchDirections?: ResearchDirection[];
  conflictingClaims?: {topic: string, perspectives: {claim: string, sources: string[]}[]}[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<{
  learnings: string[];
  learningReliabilities: number[];
  visitedUrls: string[];
  sourceMetadata: SourceMetadata[];
  weightedLearnings: LearningWithReliability[];
  conflictingClaims: {topic: string, perspectives: {claim: string, sources: string[]}[]}[];
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

  // Adaptive breadth: if we already have a significant number of learnings, reduce breadth
  const adaptiveBreadth = learnings.length > 20 ? Math.min(breadth, 3) : breadth;
  
  // Generate fewer queries when we have significant learnings
  const effectiveNumQueries = learnings.length > 10 ? Math.max(2, Math.min(adaptiveBreadth, 3)) : adaptiveBreadth;

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    learningReliabilities,
    numQueries: effectiveNumQueries, // Use adaptive number of queries
    researchDirections,  // Pass research directions to influence query generation
  });

  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0],
  });

  const limit = pLimit(ConcurrencyLimit);

  // With simplified query format, we have equal priority for all queries 
  // But we might still want to reduce number when we have sufficient learnings
  const prioritizedQueries = serpQueries
    // Limit to 70% of queries if we already have more than 15 learnings to reduce costs
    .slice(0, learnings.length > 15 ? Math.max(2, Math.ceil(serpQueries.length * 0.7)) : serpQueries.length);

  const results = await Promise.all(
    prioritizedQueries.map(queryString =>
      limit(async () => {
        try {
          const result = await firecrawl.search(queryString, {
            timeout: 15000,
            limit: 6, // Use a balanced number of results for all queries
            scrapeOptions: { 
              formats: ['markdown']
            },
            // Add date filter to prioritize recent sources (last month)
            published_after: getDateFromMonthsAgo(1),
            // Boost news sources and tech blogs for news-focused research
            boost_domains: [...newsSources, ...techBlogs],
          });

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const processedResult = await processSerpResult({
            query: queryString,
            result,
            numFollowUpQuestions: newBreadth,
            reliabilityThreshold: 0.25, // Assuming a default threshold
            researchGoal: '', // Assuming no specific research goal
          });
          
          // Log key learnings
          if (processedResult.learnings.length > 0) {
            log("\n📚 Key learnings found:");
            processedResult.learnings.forEach((learning, i) => {
              const confidence = processedResult.learningConfidences[i] || 0.5; // Default to 0.5 if undefined
              const confidenceEmoji = confidence >= 0.8 ? "✅" : confidence >= 0.5 ? "⚠️" : "❓";
              log(`  ${confidenceEmoji} [${confidence.toFixed(2)}] ${learning}`);
            });
          }
          
          const allLearnings = [...learnings, ...processedResult.learnings];
          const allUrls = [...visitedUrls, ...newUrls];
          const allSourceMetadata = [...(processedResult.sourceMetadata || [])];
          const allWeightedLearnings = [...weightedLearnings, ...processedResult.weightedLearnings];
          
          // Collect conflicting claims from this query's results
          const newConflictingClaims = processedResult.conflictingClaims || [];
          const allConflictingClaims = [...conflictingClaims, ...newConflictingClaims];
          
          // Log conflicting claims if found
          if (newConflictingClaims.length > 0) {
            log("\n⚠️ Conflicting information detected:");
            newConflictingClaims.forEach(conflict => {
              log(`  Topic: ${conflict.topic}`);
              conflict.perspectives.forEach((perspective, i) => {
                log(`    Perspective ${i+1}: ${perspective.claim}`);
                log(`    Sources: ${perspective.sources.join(', ')}`);
              });
            });
          }

          // Apply intelligent depth control - skip deeper exploration if:
          // 1. We have enough high-quality learnings already
          // 2. This branch has low confidence/reliability
          // 3. We're at a deep level and have diminishing returns
          const shouldExploreDeeper = newDepth > 0 && (
            // Always explore at least one level deep
            depth > 1 ||
            // For deeper levels, be more selective
            (processedResult.learnings.length > 0 && 
             // Either we have high confidence learnings or we have conflicting claims to resolve
             (processedResult.learningConfidences.some(c => c >= 0.7) || 
              newConflictingClaims.length > 0))
          );

          if (shouldExploreDeeper) {
            log(
              `\n🔍 Researching deeper: Depth ${newDepth}/${depth}, Breadth ${newBreadth}/${breadth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: queryString,
              parentQuery: query,
              learningsCount: processedResult.learnings.length,
              learnings: processedResult.learnings,
              followUpQuestions: processedResult.followUpQuestions,
              sources: processedResult.sourceMetadata
            });

            const nextQuery = `
Previous research goal: Research on ${queryString}
Follow-up research directions: ${processedResult.followUpQuestions.map(q => `\n${q}`).join('')}
`.trim();

            // Store deep research results and merge with existing learnings
            const recursiveResults = await deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: depth - 1,
              learnings: [...learnings, ...processedResult.learnings],
              learningReliabilities: [...learningReliabilities, ...processedResult.learningConfidences],
              visitedUrls: [...visitedUrls, ...processedResult.sourceMetadata.map(s => s.url)],
              weightedLearnings: [...weightedLearnings, ...processedResult.weightedLearnings],
              conflictingClaims: [...conflictingClaims, ...(processedResult.conflictingClaims || [])],
              researchDirections: [
                ...researchDirections,
                ...processedResult.followUpQuestions.map((q, i) => ({
                  question: q,
                  priority: processedResult.followUpPriorities[i] || 3, // Default priority if undefined
                  parentGoal: `Research on ${queryString}`
                })),
              ],
              onProgress,
            });

            return recursiveResults;
          } else {
            // Skip deeper exploration but still return results
            if (newDepth > 0) {
              log(`\n🛑 Stopping deeper exploration - sufficient information gathered or low value branch`);
            }
            
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: queryString,
              sources: processedResult.sourceMetadata
            });
            return {
              learnings: allLearnings,
              learningReliabilities: processedResult.learningConfidences,
              visitedUrls: allUrls,
              sourceMetadata: allSourceMetadata,
              weightedLearnings: allWeightedLearnings,
              conflictingClaims: allConflictingClaims
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(`Timeout error running query: ${queryString}: `, e);
          } else {
            log(`Error running query: ${queryString}: `, e);
          }
          return {
            learnings: [],
            learningReliabilities: [],
            visitedUrls: [],
            sourceMetadata: [],
            weightedLearnings: [],
            conflictingClaims: []
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
    weightedLearnings: [...new Set(results.flatMap(r => r.weightedLearnings))],
    conflictingClaims: results.flatMap(r => r.conflictingClaims || [])
  };

  return combinedResults;
}