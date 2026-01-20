import type { StructuredToolInterface } from "@langchain/core/tools";
import { readFileTool } from "./read-file.js";
import { searchWebTool } from "./search-web.js";
import { leaveCommentTool } from "./leave-comment.js";
import { submitReviewTool } from "./submit-review.js";

/**
 * All built-in tools available to the agent
 */
export const builtInTools: StructuredToolInterface[] = [
    readFileTool,
    searchWebTool,
    leaveCommentTool,
    submitReviewTool,
];

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

