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
import { submitChecklistTool } from "./submit-checklist.js";
import { reportFindingTool } from "./report-finding.js";

/** Read-only investigation tools shared across all phases */
const readOnlyTools: StructuredToolInterface[] = [
    readFilesTool,
    listDirectoryTool,
    grepTool,
    fileOutlineTool,
    viewCodeItemTool,
    findReferencesTool,
    getCommitDiffTool,
];

/**
 * Get built-in tools available to the agent
 * Some tools are conditionally included based on environment configuration
 */
function getBuiltInTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [
        ...readOnlyTools,
        leaveCommentTool,
        submitReviewTool,
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

/** MCP tools stored separately so phase-specific functions can include them */
let mcpTools: StructuredToolInterface[] = [];

/**
 * Add MCP tools to the tools array
 */
export function addMCPTools(newMcpTools: StructuredToolInterface[]): void {
    mcpTools = newMcpTools;
    tools = [...builtInTools, ...mcpTools];
}

/**
 * Phase 1 tools: read-only investigation + submit_checklist + MCP
 */
export function getPhase1Tools(): StructuredToolInterface[] {
    const phase1: StructuredToolInterface[] = [...readOnlyTools, submitChecklistTool, ...mcpTools];
    if (isWebSearchAvailable()) {
        phase1.push(searchWebTool);
    }
    return phase1;
}

/**
 * Investigation tools for sub-agents: read-only + report_finding + MCP
 */
export function getInvestigationTools(): StructuredToolInterface[] {
    return [...readOnlyTools, reportFindingTool, ...mcpTools];
}

/**
 * Phase 3 tools: read-only investigation + leave_comment + submit_review + MCP
 */
export function getPhase3Tools(): StructuredToolInterface[] {
    const phase3: StructuredToolInterface[] = [
        ...readOnlyTools,
        leaveCommentTool,
        submitReviewTool,
        ...mcpTools,
    ];
    if (isWebSearchAvailable()) {
        phase3.push(searchWebTool);
    }
    return phase3;
}
