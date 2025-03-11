import { ResearchProgress } from './deep-research.js';

export class OutputManager {
  private initialized: boolean = false;

  constructor() {
    this.initialized = true;
  }

  log(...args: any[]) {
    // Print log message to stderr
    console.error(...args);
  }

  updateProgress(progress: ResearchProgress) {
    // Simple text-based progress reporting
    if (progress.currentQuery) {
      if (progress.parentQuery) {
        this.log(`\n[Depth ${progress.currentDepth}/${progress.totalDepth}] Following up on: "${progress.parentQuery}"`);
      }
      this.log(`\n[Query ${progress.completedQueries + 1}/${progress.totalQueries}] Searching: "${progress.currentQuery}"`);
    }
    
    // Print learnings if available
    if (progress.learnings && progress.learnings.length > 0) {
      this.log("\n📚 New learnings:");
      progress.learnings.forEach((learning, i) => {
        this.log(`  ${i + 1}. ${learning}`);
      });
    }
    
    // Print follow-up questions if available
    if (progress.followUpQuestions && progress.followUpQuestions.length > 0) {
      this.log("\n❓ Follow-up questions:");
      progress.followUpQuestions.forEach((question, i) => {
        this.log(`  ${i + 1}. ${question}`);
      });
    }
    
    // Print sources if available
    if (progress.sources && progress.sources.length > 0) {
      this.log("\n🔗 Sources found:");
      progress.sources.forEach(source => {
        const reliabilityEmoji = source.reliabilityScore >= 0.8 ? "✅" : 
                                source.reliabilityScore >= 0.5 ? "⚠️" : "❌";
        this.log(`  ${reliabilityEmoji} [${source.reliabilityScore.toFixed(2)}] ${source.url} - ${source.domain}`);
        if (source.title) {
          this.log(`    Title: ${source.title}`);
        }
        if (source.publishDate) {
          this.log(`    Published: ${source.publishDate}`);
        }
      });
    }
  }
}
