# Prompt Management System

This module centralizes all prompts used in the Deep Research system, making them easier to understand, modify, and debug.

## How Prompts are Organized

The `index.ts` file exports:

1. **Individual prompt functions** - Each function generates a specific prompt with parameters
2. **Debug utilities** - Tools for logging prompts and responses
3. **A default export** with all utilities combined

## Using Prompts

Import the prompts module:

```typescript
import prompts from './prompts/index.js';
```

Then use any prompt function:

```typescript
// Generate a prompt for search queries
const promptText = prompts.generateQueriesPrompt({
  query: "Latest AI developments",
  numQueries: 5
});

// Log the prompt (if debugging enabled)
prompts.logPrompt('My Custom Query', 'GPT-4', promptText);
```

## Customizing Prompts

To modify a prompt, simply edit the function in `index.ts`. For example:

```typescript
export const sourceReliabilityPrompt = (domain: string, context: string) => {
  return `Your custom reliability evaluation prompt here.
  
Domain: ${domain}
Context: ${context}

Evaluate reliability factors:
1. Your custom factor
2. Another important factor
...`;
};
```

## Adding New Prompts

To add new prompts:

1. Create your prompt function in `index.ts`
2. Document what it does with JSDoc comments
3. Add it to the default export at the bottom of the file
4. Use it in your code

Example:

```typescript
/**
 * Custom prompt for any new functionality
 */
export const myCustomPrompt = (param: string) => {
  return `This is my custom prompt with ${param}`;
};

// Add to default export
export default {
  // ... existing exports
  myCustomPrompt
};
```

## Debugging Prompts

Set `DEBUG_PROMPTS=true` in your `.env.local` file to log all prompts.

You can also view individual prompts using:

```typescript
// Manually log a specific prompt
prompts.logPrompt('Prompt Name', 'Model Name', promptText);
```

This helps with troubleshooting by showing exactly what's being sent to each LLM. 