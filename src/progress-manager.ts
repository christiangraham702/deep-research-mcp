import { ResearchProgress } from './deep-research.js';

export class ProgressManager {
  private lastProgress: ResearchProgress | undefined;
  private initialized: boolean = false;

  constructor() {
    this.initialized = true;
  }

  updateProgress(progress: ResearchProgress) {
    // Store progress for potential reference
    this.lastProgress = progress;
    
    // Simple text output for progress
    if (progress.currentQuery) {
      console.log(`[Research] Depth: ${progress.currentDepth}/${progress.totalDepth}, Queries: ${progress.completedQueries}/${progress.totalQueries}`);
      console.log(`[Research] Current: "${progress.currentQuery}"`);
    }
  }

  stop() {
    // Nothing to clean up in the new implementation
    console.log("[Research] Complete");
  }
}
