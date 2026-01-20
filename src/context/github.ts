import * as github from "@actions/github";
import type {
    PRContext,
    ReviewComment,
    ConversationComment,
} from "./types.js";
import { readPreferences } from "../preferences/index.js";

type Octokit = ReturnType<typeof github.getOctokit>;

let octokit: Octokit;

/**
 * Initialize the GitHub client
 */
export function initGitHub(token: string): void {
    octokit = github.getOctokit(token);
}

/**
 * Get the Octokit instance (for use in tools)
 */
export function getOctokit(): Octokit {
    if (!octokit) {
        throw new Error("GitHub client not initialized. Call initGitHub first.");
    }
    return octokit;
}

/**
 * Gather all context needed for PR review
 */
export async function gatherPRContext(
    owner: string,
    repo: string,
    prNumber: number
): Promise<PRContext> {
    const [pr, diff, tree, reviewComments, issueComments, preferences] = await Promise.all([
        getPullRequest(owner, repo, prNumber),
        getPRDiff(owner, repo, prNumber),
        getProjectTree(owner, repo, process.env.HEAD_SHA!),
        getReviewComments(owner, repo, prNumber),
        getConversation(owner, repo, prNumber),
        readPreferences(owner, repo),
    ]);

    return {
        owner,
        repo,
        prNumber,
        title: pr.title,
        description: pr.body,
        author: pr.user?.login || "unknown",
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        diff,
        fileTree: tree,
        existingComments: reviewComments,
        conversation: issueComments,
        preferences,
    };
}

/**
 * Get PR details
 */
async function getPullRequest(owner: string, repo: string, prNumber: number) {
    const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
    });
    return data;
}

/**
 * Get the unified diff for a PR
 */
async function getPRDiff(
    owner: string,
    repo: string,
    prNumber: number
): Promise<string> {
    const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: {
            format: "diff",
        },
    });
    // When requesting diff format, data is returned as a string
    return data as unknown as string;
}

/**
 * Get the project file tree at a specific ref
 */
async function getProjectTree(
    owner: string,
    repo: string,
    ref: string
): Promise<string> {
    try {
        const { data } = await octokit.rest.git.getTree({
            owner,
            repo,
            tree_sha: ref,
            recursive: "true",
        });

        // Format as a simple tree structure
        const files = data.tree
            .filter((item) => item.type === "blob")
            .map((item) => item.path)
            .sort();

        return files.join("\n");
    } catch (error) {
        console.error("Error fetching project tree:", error);
        return "(Unable to fetch project tree)";
    }
}

/**
 * Get existing review comments on the PR
 */
async function getReviewComments(
    owner: string,
    repo: string,
    prNumber: number
): Promise<ReviewComment[]> {
    const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
    });

    return data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login || "unknown",
        body: comment.body,
        path: comment.path,
        line: comment.line || null,
        createdAt: comment.created_at,
    }));
}

/**
 * Get conversation comments on the PR (issue comments)
 */
async function getConversation(
    owner: string,
    repo: string,
    prNumber: number
): Promise<ConversationComment[]> {
    const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
    });

    return data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login || "unknown",
        body: comment.body || "",
        createdAt: comment.created_at,
    }));
}

/**
 * Read a file from the repository at a specific ref
 */
export async function readFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    startLine?: number,
    endLine?: number
): Promise<string> {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref,
        });

        if ("content" in data && data.type === "file") {
            const content = Buffer.from(data.content, "base64").toString("utf-8");

            // Apply line filtering if specified
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split("\n");
                const start = (startLine || 1) - 1; // Convert to 0-indexed
                const end = endLine || lines.length;
                return lines.slice(start, end).join("\n");
            }

            return content;
        }

        return "(Path is a directory, not a file)";
    } catch (error) {
        if (error instanceof Error && error.message.includes("Not Found")) {
            return `(File not found: ${path})`;
        }
        throw error;
    }
}

/**
 * Create a review comment on a specific line of a file
 */
export async function createReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commitId: string,
    path: string,
    line: number,
    body: string,
    side: "LEFT" | "RIGHT" = "RIGHT",
    startLine?: number
): Promise<void> {
    const params: Parameters<Octokit["rest"]["pulls"]["createReviewComment"]>[0] =
    {
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        path,
        body,
        line,
        side,
    };

    // Add multi-line support if startLine is provided
    if (startLine !== undefined && startLine < line) {
        params.start_line = startLine;
        params.start_side = side;
    }

    await octokit.rest.pulls.createReviewComment(params);
}

/**
 * Create a general comment on the PR (for summary)
 */
export async function createPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
): Promise<void> {
    await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
    });
}

/**
 * Reply to a review comment (creates a reply in the same thread)
 */
export async function replyToReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string
): Promise<void> {
    await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: commentId,
        body,
    });
}
