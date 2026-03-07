import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Tool for the Phase 1 triage agent to submit a structured checklist of issues to investigate.
 * This is a data-passing tool with no side effects.
 */
export const submitChecklistTool = tool(
    async ({ items }) => {
        return JSON.stringify(items);
    },
    {
        name: "submit_checklist",
        description:
            "Submit your structured checklist of issues to investigate. Call this exactly once at the end of your triage phase with all items you want investigated.",
        schema: z.object({
            items: z
                .array(
                    z.object({
                        id: z.number().describe("Unique sequential ID for this checklist item (1, 2, 3, ...)"),
                        description: z.string().describe("What looks suspicious and why"),
                        file: z.string().describe("Primary file path where the issue is located"),
                        line: z
                            .number()
                            .optional()
                            .nullable()
                            .describe("Approximate line number in the file"),
                        verification: z
                            .string()
                            .describe("What needs to be verified (e.g., 'is X null-safe?', 'does Y handle errors?')"),
                        related_files: z
                            .array(z.string())
                            .optional()
                            .nullable()
                            .describe("Other files relevant to investigating this item (e.g., callers, shared types)"),
                    })
                )
                .describe("The checklist items to investigate"),
        }),
    }
);
