import type { StructuredToolInterface } from "@langchain/core/tools";
import { readFilesTool } from "./read-file.js";
import { listDirectoryTool } from "./list-directory.js";
import { searchWebTool, isWebSearchAvailable } from "./search-web.js";
import { leaveCommentTool } from "./leave-comment.js";
import { submitReviewTool } from "./submit-review.js";
import { grepTool } from "./grep.js";
import { fileOutlineTool } from "./file-outline.js";
import { viewCodeItemTool } from "./view-code-item.js";
import { findReferencesTool } from "./find-references.js";
import { getCommitDiffTool } from "./get-commit-diff.js";
import { getFileDiffTool } from "./get-file-diff.js";
import { getReviewCommentsTool } from "./get-review-comments.js";

/**
 * Get built-in tools available to the agent
 * Some tools are conditionally included based on environment configuration
 */
function getBuiltInTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
        readFilesTool,
        listDirectoryTool,
        leaveCommentTool,
        submitReviewTool,
        grepTool,
        fileOutlineTool,
        viewCodeItemTool,
        findReferencesTool,
        getCommitDiffTool,
        getFileDiffTool,
        getReviewCommentsTool,
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
