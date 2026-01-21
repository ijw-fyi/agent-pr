import type { StructuredToolInterface } from "@langchain/core/tools";
import { readFileTool } from "./read-file.js";
import { listDirectoryTool } from "./list-directory.js";
import { searchWebTool, isWebSearchAvailable } from "./search-web.js";
import { leaveCommentTool } from "./leave-comment.js";
import { submitReviewTool } from "./submit-review.js";
import { grepTool } from "./grep.js";

/**
 * Get built-in tools available to the agent
 * Some tools are conditionally included based on environment configuration
 */
function getBuiltInTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
        readFileTool,
        listDirectoryTool,
        leaveCommentTool,
        submitReviewTool,
        grepTool,
    ];

    // Only include web search tool if GEMINI_API_KEY is available
    if (isWebSearchAvailable()) {
        tools.push(searchWebTool);
    }

    return tools;
}

/**
 * All built-in tools available to the agent
 */
export const builtInTools: StructuredToolInterface[] = getBuiltInTools();

/**
 * Combined tools array (built-in + MCP tools)
 * MCP tools will be added dynamically at runtime
 */
export let tools: StructuredToolInterface[] = [...builtInTools];

/**
 * Add MCP tools to the tools array
 */
export function addMCPTools(mcpTools: StructuredToolInterface[]): void {
    tools = [...builtInTools, ...mcpTools];
}
