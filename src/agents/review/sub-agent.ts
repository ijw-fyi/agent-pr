import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import PQueue from "p-queue";
import { getSubAgentPrompt } from "./sub-agent-prompt.js";
import { getInvestigationTools } from "../../tools/index.js";
import { createCachedChatOpenAI, isOverBudget } from "../../helpers/cached-model.js";
import { processChunk } from "../../helpers/stream-utils.js";

export interface ChecklistItem {
    id: number;
    description: string;
    file: string;
    line?: number | null;
    verification: string;
    related_files?: string[] | null;
}

export interface AdditionalConcern {
    description: string;
    file: string;
    line?: number | null;
    verification: string;
}

export interface SubAgentFinding {
    checklist_item_id: number;
    status: "confirmed" | "dismissed" | "needs_review";
    summary: string;
    details: string;
    file: string;
    line?: number | null;
    severity?: "critical" | "major" | "minor" | null;
    suggested_comment?: string | null;
    additional_concerns?: AdditionalConcern[] | null;
}

/**
 * Filter a full diff to only include files matching the given paths.
 * Splits by "diff --git" headers and keeps matching parts.
 */
function filterDiffForFiles(diff: string, filePaths: string[]): string {
    const parts = diff.split(/(?=^diff --git )/m);
    const pathSet = new Set(filePaths);

    return parts.filter(part => {
        if (!part.trim()) return true;
        const headerLine = part.split('\n')[0];
        const match = headerLine.match(/diff --git a\/(.*?) b\//);
        if (match) {
            return pathSet.has(match[1]);
        }
        return true;
    }).join('');
}

/**
 * Run a single sub-agent to investigate one checklist item.
 * Returns the finding, or null if the sub-agent failed to report.
 */
async function runSubAgent(
    item: ChecklistItem,
    contextMessage: string,
    fullDiff: string,
): Promise<SubAgentFinding | null> {
    const model = createCachedChatOpenAI();
    const tools = getInvestigationTools();
    const agent = createReactAgent({ llm: model, tools });

    // Build filtered diff for this item's files
    const relevantFiles = [item.file, ...(item.related_files || [])];
    const filteredDiff = filterDiffForFiles(fullDiff, relevantFiles);

    const userMessage = `${contextMessage}

## Relevant Diff for Your Investigation
\`\`\`diff
${filteredDiff}
\`\`\`
`;

    const allMessages: BaseMessage[] = [
        new SystemMessage(getSubAgentPrompt(item)),
        new HumanMessage(userMessage),
    ];

    const abortController = new AbortController();

    try {
        const stream = await agent.stream(
            { messages: allMessages },
            { recursionLimit: 15, signal: abortController.signal }
        );

        let stepCount = 0;
        for await (const chunk of stream) {
            stepCount++;
            processChunk(chunk, stepCount, allMessages);

            if (isOverBudget()) {
                console.log(`  ⚠️ Sub-agent #${item.id}: Budget exceeded, aborting`);
                abortController.abort();
                break;
            }
        }
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            // Expected when we abort due to budget
        } else {
            console.error(`  ❌ Sub-agent #${item.id} error:`, error);
            return null;
        }
    }

    // Extract finding from report_finding ToolMessage
    for (const msg of allMessages) {
        if (msg instanceof ToolMessage && msg.name === 'report_finding') {
            try {
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                return JSON.parse(content) as SubAgentFinding;
            } catch {
                console.error(`  ❌ Sub-agent #${item.id}: Failed to parse report_finding output`);
            }
        }
    }

    console.log(`  ⚠️ Sub-agent #${item.id}: Did not call report_finding`);
    return null;
}

/**
 * Run multiple sub-agents in parallel with concurrency control.
 * Checks budget before launching each sub-agent.
 */
export async function runSubAgentsInParallel(
    items: ChecklistItem[],
    contextMessage: string,
    fullDiff: string,
    maxConcurrency: number = 5,
): Promise<(SubAgentFinding | null)[]> {
    const queue = new PQueue({ concurrency: maxConcurrency });

    const promises = items.map(item =>
        queue.add(async () => {
            if (isOverBudget()) {
                console.log(`  ⚠️ Skipping sub-agent #${item.id}: Budget exceeded`);
                return null;
            }

            console.log(`::group::🔍 Sub-Agent #${item.id}: ${item.description.substring(0, 80)}`);
            const result = await runSubAgent(item, contextMessage, fullDiff);
            if (result) {
                const icon = result.status === 'confirmed' ? '🐛' : result.status === 'dismissed' ? '✅' : '❓';
                console.log(`  ${icon} Result: ${result.status} — ${result.summary}`);
            } else {
                console.log(`  ⚠️ Result: inconclusive (no finding reported)`);
            }
            console.log(`::endgroup::`);
            return result;
        }).catch(error => {
            console.error(`  ❌ Sub-agent #${item.id} rejected:`, error);
            return null;
        })
    );

    return Promise.all(promises);
}

/**
 * Format sub-agent findings into a structured summary for the Phase 3 agent.
 */
export function formatFindings(
    items: ChecklistItem[],
    findings: (SubAgentFinding | null)[],
): string {
    const confirmed: string[] = [];
    const dismissed: string[] = [];
    const needsReview: string[] = [];
    const inconclusive: string[] = [];
    const additionalConcerns: string[] = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const finding = findings[i];

        if (!finding) {
            inconclusive.push(`- **Item #${item.id}** (${item.file}): ${item.description} — Sub-agent did not complete investigation`);
            continue;
        }

        const line = finding.line ? `:${finding.line}` : '';
        const severity = finding.severity ? ` [${finding.severity}]` : '';

        switch (finding.status) {
            case 'confirmed':
                confirmed.push(
                    `- **Item #${finding.checklist_item_id}**${severity} (\`${finding.file}${line}\`): ${finding.summary}\n  - Details: ${finding.details}${finding.suggested_comment ? `\n  - Suggested comment: ${finding.suggested_comment}` : ''}`
                );
                break;
            case 'dismissed':
                dismissed.push(
                    `- **Item #${finding.checklist_item_id}** (\`${finding.file}\`): ${finding.summary}\n  - Reason: ${finding.details}`
                );
                break;
            case 'needs_review':
                needsReview.push(
                    `- **Item #${finding.checklist_item_id}** (\`${finding.file}${line}\`): ${finding.summary}\n  - Details: ${finding.details}`
                );
                break;
        }

        if (finding.additional_concerns?.length) {
            for (const concern of finding.additional_concerns) {
                const cLine = concern.line ? `:${concern.line}` : '';
                additionalConcerns.push(
                    `- (\`${concern.file}${cLine}\`): ${concern.description}\n  - Needs verification: ${concern.verification}`
                );
            }
        }
    }

    let summary = `## Investigation Results\n\n`;

    if (confirmed.length > 0) {
        summary += `### Confirmed Issues (${confirmed.length})\nThese issues were verified by sub-agents. Leave an inline comment for each one.\n${confirmed.join('\n\n')}\n\n`;
    }

    if (needsReview.length > 0) {
        summary += `### Needs Further Review (${needsReview.length})\nSub-agents could not fully determine these. Investigate briefly before deciding.\n${needsReview.join('\n\n')}\n\n`;
    }

    if (additionalConcerns.length > 0) {
        summary += `### Additional Concerns (${additionalConcerns.length})\nSub-agents noticed these while investigating their assigned items. Evaluate and investigate if warranted.\n${additionalConcerns.join('\n\n')}\n\n`;
    }

    if (dismissed.length > 0) {
        summary += `### Dismissed (${dismissed.length})\nThese were investigated and found to be non-issues.\n${dismissed.join('\n\n')}\n\n`;
    }

    if (inconclusive.length > 0) {
        summary += `### Inconclusive (${inconclusive.length})\nThese items were not investigated (budget exceeded or sub-agent failed).\n${inconclusive.join('\n\n')}\n\n`;
    }

    return summary;
}
