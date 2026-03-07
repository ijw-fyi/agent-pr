import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Tool for investigation sub-agents to report their findings.
 * This is a data-passing tool with no side effects.
 */
export const reportFindingTool = tool(
    async (input) => {
        return JSON.stringify(input);
    },
    {
        name: "report_finding",
        description:
            "Report your investigation finding for your assigned checklist item. Call this exactly once when you have finished investigating.",
        schema: z.object({
            checklist_item_id: z
                .number()
                .describe("The ID of the checklist item you investigated"),
            status: z
                .enum(["confirmed", "dismissed", "needs_review"])
                .describe(
                    "confirmed: the issue is real. dismissed: not an issue after investigation. needs_review: could not fully determine, needs human review."
                ),
            summary: z
                .string()
                .describe("Brief one-line summary of your finding"),
            details: z
                .string()
                .describe("Full details including evidence from code you read"),
            file: z.string().describe("The primary file affected"),
            line: z
                .number()
                .optional()
                .nullable()
                .describe("The specific line number affected, if applicable"),
            severity: z
                .enum(["critical", "major", "minor"])
                .optional()
                .nullable()
                .describe("Severity of the issue (only for confirmed issues)"),
            suggested_comment: z
                .string()
                .optional()
                .nullable()
                .describe(
                    "A pre-drafted inline comment to leave on the code, in Markdown. Include issue description and suggested fix."
                ),
            additional_concerns: z
                .array(
                    z.object({
                        description: z.string().describe("What looks suspicious"),
                        file: z.string().describe("File path"),
                        line: z
                            .number()
                            .optional()
                            .nullable()
                            .describe("Approximate line number"),
                        verification: z
                            .string()
                            .describe("What needs to be verified"),
                    })
                )
                .optional()
                .nullable()
                .describe(
                    "Other suspicious things you noticed in code you already read during your investigation. Do NOT go looking for extra issues — only report things you stumbled upon."
                ),
        }),
    }
);
