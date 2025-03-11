import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { Config } from './config.js';
import { deepResearch, writeFinalReport } from './deep-research.js';

// Helper function to log to stderr
const log = (...args: any[]) => {
  process.stderr.write(
    args
      .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ') + '\n',
  );
};

// Log environment check
log('Environment check:', {
  hasOpenAiKey: !!Config.openai.apiKey,
  hasFirecrawlKey: !!Config.firecrawl.apiKey,
  firecrawlBaseUrl: Config.firecrawl.baseUrl || '(using API)',
  firecrawlConcurrency: Config.firecrawl.concurrency,
});

const server = new McpServer({
  name: 'deep-research',
  version: '1.0.0',
});

// Define the deep research tool
server.tool(
  'deep-research',
  'Perform deep research on a topic using AI-powered web search',
  {
    query: z.string().min(1).describe("The research query to investigate"),
    depth: z.number().min(1).max(5).describe("How deep to go in the research tree (1-5)"),
    breadth: z.number().min(1).max(5).describe("How broad to make each research level (1-5)")
  },
  async ({ query, depth, breadth }) => {
    try {
      let currentProgress = '';

      const result = await deepResearch({
        query,
        depth,
        breadth,
        onProgress: progress => {
          const progressMsg = `Depth ${progress.currentDepth}/${progress.totalDepth}, Query ${progress.completedQueries}/${progress.totalQueries}: ${progress.currentQuery || ''}`;
          if (progressMsg !== currentProgress) {
            currentProgress = progressMsg;
            log(progressMsg);

            server.server
              .notification({
                method: 'notifications/progress',
                params: {
                  progressToken: 0,
                  data: progressMsg,
                },
              })
              .catch(error => {
                log('Error sending progress notification:', error);
              });
          }
        },
      });

      const report = await writeFinalReport({
        prompt: query,
        learnings: result.learnings,
        visitedUrls: result.visitedUrls,
        sourceMetadata: result.sourceMetadata,
        conflictingClaims: result.conflictingClaims || []
      });

      return {
        content: [
          {
            type: 'text',
            text: report,
          },
        ],
        metadata: {
          learnings: result.learnings,
          visitedUrls: result.visitedUrls,
          stats: {
            totalLearnings: result.learnings.length,
            totalSources: result.visitedUrls.length,
            averageReliability: result.weightedLearnings.reduce((acc, curr) => acc + curr.reliability, 0) / result.weightedLearnings.length
          },
        },
      };
    } catch (error) {
      log(
        'Error in deep research:',
        error instanceof Error ? error.message : String(error),
      );
      return {
        content: [
          {
            type: 'text',
            text: `Error performing research: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Deep Research MCP Server running on stdio');
  } catch (error) {
    log('Error starting server:', error);
    process.exit(1);
  }
}

main().catch(error => {
  log('Fatal error in main():', error);
  process.exit(1);
});