/**
 * DEEP RESEARCH DEBUG UTILITIES
 * 
 * This file contains utilities for debugging the Deep Research system.
 * It provides different levels of logging and visualization tools.
 */

// Configuration
export type DebugConfig = {
  enabled: boolean;
  level: DebugLevel;
  logPrompts: boolean;
  logResponses: boolean;
  logProgress: boolean;
  logSources: boolean;
  colorize: boolean;
};

export enum DebugLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5
}

// Default configuration
export const debugConfig: DebugConfig = {
  enabled: process.env.DEBUG_MODE === 'true',
  level: process.env.DEBUG_LEVEL ? 
    parseInt(process.env.DEBUG_LEVEL) as DebugLevel : 
    DebugLevel.INFO,
  logPrompts: process.env.DEBUG_PROMPTS === 'true',
  logResponses: process.env.DEBUG_RESPONSES === 'true',
  logProgress: process.env.DEBUG_PROGRESS === 'true',
  logSources: process.env.DEBUG_SOURCES === 'true',
  colorize: true
};

// ANSI Color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  fg: {
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
  },
  
  bg: {
    black: '\x1b[40m',
    red: '\x1b[41m',
    green: '\x1b[42m',
    yellow: '\x1b[43m',
    blue: '\x1b[44m',
    magenta: '\x1b[45m',
    cyan: '\x1b[46m',
    white: '\x1b[47m',
    gray: '\x1b[100m',
  }
};

/**
 * Creates an OpenAI-compatible schema by removing constraints that
 * are not supported by OpenAI's API
 */
export const createOpenAISchema = (schema: any): any => {
  // OpenAI doesn't support maxItems, maxLength, or similar constraints
  // This function provides a way to sanitize schemas for OpenAI compatibility
  
  // A simple implementation for now - more complex schemas may need deeper processing
  if (schema && typeof schema === 'object') {
    // For arrays, remove maxItems constraint
    if (schema.type === 'array' && 'maxItems' in schema) {
      const { maxItems, ...rest } = schema;
      return rest;
    }
    
    // For strings, remove maxLength constraint
    if (schema.type === 'string' && 'maxLength' in schema) {
      const { maxLength, ...rest } = schema;
      return rest;
    }
    
    // For objects, process each property
    if (schema.type === 'object' && schema.properties) {
      return {
        ...schema,
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]: [string, any]): [string, any] => [key, createOpenAISchema(value)])
        )
      };
    }
    
    // For arrays with items, process the items schema
    if (schema.type === 'array' && schema.items) {
      return {
        ...schema,
        items: createOpenAISchema(schema.items)
      };
    }
  }
  
  // Return as-is if no changes needed
  return schema;
};

/**
 * Main debug logger with support for different levels
 */
export const debug = {
  error: (...args: any[]) => {
    if (debugConfig.enabled && debugConfig.level >= DebugLevel.ERROR) {
      console.error(
        debugConfig.colorize ? `${colors.fg.red}[ERROR]${colors.reset}` : '[ERROR]',
        ...args
      );
    }
  },
  
  warn: (...args: any[]) => {
    if (debugConfig.enabled && debugConfig.level >= DebugLevel.WARN) {
      console.warn(
        debugConfig.colorize ? `${colors.fg.yellow}[WARN]${colors.reset}` : '[WARN]',
        ...args
      );
    }
  },
  
  info: (...args: any[]) => {
    if (debugConfig.enabled && debugConfig.level >= DebugLevel.INFO) {
      console.log(
        debugConfig.colorize ? `${colors.fg.cyan}[INFO]${colors.reset}` : '[INFO]',
        ...args
      );
    }
  },
  
  debug: (...args: any[]) => {
    if (debugConfig.enabled && debugConfig.level >= DebugLevel.DEBUG) {
      console.log(
        debugConfig.colorize ? `${colors.fg.green}[DEBUG]${colors.reset}` : '[DEBUG]',
        ...args
      );
    }
  },
  
  trace: (...args: any[]) => {
    if (debugConfig.enabled && debugConfig.level >= DebugLevel.TRACE) {
      console.log(
        debugConfig.colorize ? `${colors.fg.gray}[TRACE]${colors.reset}` : '[TRACE]',
        ...args
      );
    }
  },
  
  // Specialized loggers
  prompt: (promptName: string, model: string, promptText: string) => {
    if (debugConfig.enabled && debugConfig.logPrompts) {
      console.log(
        debugConfig.colorize ? 
          `\n${colors.bg.blue}${colors.fg.white}${colors.bright} PROMPT: ${promptName} (${model}) ${colors.reset}\n` : 
          `\n=== PROMPT: ${promptName} (${model}) ===\n`
      );
      console.log(promptText);
      console.log(
        debugConfig.colorize ? 
          `\n${colors.bg.blue}${colors.fg.white}${colors.bright} END PROMPT ${colors.reset}\n` : 
          '\n=== END PROMPT ===\n'
      );
    }
  },
  
  response: (promptName: string, model: string, response: any) => {
    if (debugConfig.enabled && debugConfig.logResponses) {
      console.log(
        debugConfig.colorize ? 
          `\n${colors.bg.green}${colors.fg.black}${colors.bright} RESPONSE: ${promptName} (${model}) ${colors.reset}\n` : 
          `\n=== RESPONSE: ${promptName} (${model}) ===\n`
      );
      console.log(typeof response === 'string' ? response : JSON.stringify(response, null, 2));
      console.log(
        debugConfig.colorize ? 
          `\n${colors.bg.green}${colors.fg.black}${colors.bright} END RESPONSE ${colors.reset}\n` : 
          '\n=== END RESPONSE ===\n'
      );
    }
  },
  
  source: (source: { url: string; domain: string; reliabilityScore: number }) => {
    if (debugConfig.enabled && debugConfig.logSources) {
      const reliabilityEmoji = source.reliabilityScore >= 0.8 ? "✅" : 
                               source.reliabilityScore >= 0.5 ? "⚠️" : "❌";
      
      const reliabilityColor = source.reliabilityScore >= 0.8 ? colors.fg.green : 
                               source.reliabilityScore >= 0.5 ? colors.fg.yellow : colors.fg.red;
      
      console.log(
        debugConfig.colorize ? 
          `  ${reliabilityEmoji} ${reliabilityColor}[${source.reliabilityScore.toFixed(2)}]${colors.reset} ${source.domain}: ${source.url}` : 
          `  ${reliabilityEmoji} [${source.reliabilityScore.toFixed(2)}] ${source.domain}: ${source.url}`
      );
    }
  },
  
  progress: (progress: any) => {
    if (debugConfig.enabled && debugConfig.logProgress) {
      console.log(
        debugConfig.colorize ? 
          `${colors.fg.magenta}[PROGRESS]${colors.reset}` : 
          '[PROGRESS]', 
        progress
      );
    }
  },
  
  // Timer for performance measurement
  timer: (label: string) => {
    const start = performance.now();
    return {
      end: () => {
        const duration = performance.now() - start;
        debug.info(`${label} took ${duration.toFixed(2)}ms`);
        return duration;
      }
    };
  },
  
  // Format object for better visualization
  formatObject: (obj: any) => {
    return JSON.stringify(obj, null, 2);
  }
};

export default debug; 