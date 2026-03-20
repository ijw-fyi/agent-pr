import * as github from "@actions/github";
import type {
    PRContext,
    PRCommit,
    ReviewComment,
    ReviewSummary,
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
    const [pr, diff, reviewComments, issueComments, preferences, commits, reviewSummaries, botLogin] = await Promise.all([
        getPullRequest(owner, repo, prNumber),
        getPRDiff(owner, repo, prNumber),
        getReviewComments(owner, repo, prNumber),
        getConversation(owner, repo, prNumber),
        readPreferences(owner, repo),
        getPRCommits(owner, repo, prNumber),
        getPreviousReviewSummaries(owner, repo, prNumber),
        getBotLogin(),
    ]);

    // Fetch CLAUDE.md from the base branch (not parallel with above since we need pr.base.ref)
    const claudeMd = await fetchClaudeMd(owner, repo, pr.base.ref);

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
        commits,
        diff,
        existingComments: reviewComments,
        conversation: issueComments,
        preferences,
        claudeMd,
        reviewSummaries,
        botLogin,
    };
}

/**
 * Fetch CLAUDE.md from the repository root at a given ref.
 * Returns the file content, or null if it doesn't exist.
 */
async function fetchClaudeMd(owner: string, repo: string, ref: string): Promise<string | null> {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: "CLAUDE.md",
            ref,
        });

        if ("content" in data && data.type === "file") {
            return Buffer.from(data.content, "base64").toString("utf-8");
        }
        return null;
    } catch {
        return null;
    }
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
export async function getPRDiff(
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
 * Get resolved thread info via GraphQL
 */
async function getResolvedThreads(
    owner: string,
    repo: string,
    prNumber: number
): Promise<Set<number>> {
    const query = `
        query($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                    reviewThreads(first: 100) {
                        nodes {
                            isResolved
                            comments(first: 100) {
                                nodes {
                                    databaseId
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    try {
        const result: {
            repository: {
                pullRequest: {
                    reviewThreads: {
                        nodes: Array<{
                            isResolved: boolean;
                            comments: { nodes: Array<{ databaseId: number }> };
                        }>;
                    };
                };
            };
        } = await octokit.graphql(query, { owner, repo, prNumber });

        const resolvedIds = new Set<number>();
        for (const thread of result.repository.pullRequest.reviewThreads.nodes) {
            if (thread.isResolved) {
                for (const comment of thread.comments.nodes) {
                    resolvedIds.add(comment.databaseId);
                }
            }
        }
        return resolvedIds;
    } catch (error) {
        console.warn("Failed to fetch resolved threads via GraphQL:", error);
        return new Set();
    }
}

/**
 * Get existing review comments on the PR
 */
export async function getReviewComments(
    owner: string,
    repo: string,
    prNumber: number
): Promise<ReviewComment[]> {
    const [{ data }, resolvedThreadIds] = await Promise.all([
        octokit.rest.pulls.listReviewComments({
            owner,
            repo,
            pull_number: prNumber,
        }),
        getResolvedThreads(owner, repo, prNumber),
    ]);

    return data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login || "unknown",
        body: comment.body,
        path: comment.path,
        line: comment.line || null,
        createdAt: comment.created_at,
        isResolved: resolvedThreadIds.has(comment.id),
        inReplyToId: comment.in_reply_to_id || null,
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
 * Get the authenticated bot's GitHub login
 */
// Cache: safe because this runs in a single-use GitHub Actions process
let resolvedBotLogin: string | null = null;

async function getBotLogin(): Promise<string> {
    if (resolvedBotLogin !== null) return resolvedBotLogin;

    // Try GET /user first (works with user tokens / PATs)
    try {
        const { data: currentUser } = await octokit.rest.users.getAuthenticated();
        console.log(`Bot login resolved via /user: ${currentUser.login}`);
        resolvedBotLogin = currentUser.login;
        return resolvedBotLogin;
    } catch {
        // GET /user fails with installation tokens (GITHUB_TOKEN) — try GET /app
    }

    // Fallback: GET /app works with JWT-based GitHub App tokens
    try {
        const { data: app } = await octokit.rest.apps.getAuthenticated();
        resolvedBotLogin = `${app.slug}[bot]`;
        console.log(`Bot login resolved via /app: ${resolvedBotLogin}`);
        return resolvedBotLogin;
    } catch {
        // GET /app requires a JWT — fails with installation tokens (GITHUB_TOKEN)
    }

    // Fallback: explicit override for custom GitHub App setups
    if (process.env.PR_AGENT_BOT_LOGIN) {
        resolvedBotLogin = process.env.PR_AGENT_BOT_LOGIN;
        console.log(`Bot login from PR_AGENT_BOT_LOGIN env: ${resolvedBotLogin}`);
        return resolvedBotLogin;
    }

    // Fallback: in GitHub Actions, the default GITHUB_TOKEN acts as github-actions[bot]
    if (process.env.GITHUB_ACTIONS === "true") {
        resolvedBotLogin = "github-actions[bot]";
        console.log(`Bot login inferred from GITHUB_ACTIONS env: ${resolvedBotLogin}`);
        return resolvedBotLogin;
    }

    console.warn("Could not resolve bot login via any method");
    resolvedBotLogin = "unknown";
    return resolvedBotLogin;
}

/**
 * Get review summaries on this PR (all reviews with non-empty bodies)
 */
async function getPreviousReviewSummaries(
    owner: string,
    repo: string,
    prNumber: number
): Promise<ReviewSummary[]> {
    try {
        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
            owner,
            repo,
            pull_number: prNumber,
            per_page: 100,
        });

        return reviews
            .filter((review) => review.body?.trim())
            .map((review) => ({
                author: review.user?.login || "unknown",
                body: review.body!,
                state: review.state,
                submittedAt: review.submitted_at || "",
            }));
    } catch (error) {
        console.warn("Failed to fetch previous review summaries:", error instanceof Error ? error.message : error);
        return [];
    }
}

/**
 * Get the list of commits in a PR
 */
async function getPRCommits(
    owner: string,
    repo: string,
    prNumber: number
): Promise<PRCommit[]> {
    const { data } = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
    });

    if (data.length === 100) {
        console.warn(`PR #${prNumber} has 100+ commits — only showing first 100`);
    }

    return data.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.author?.login || commit.commit.author?.name || "unknown",
        date: commit.commit.author?.date || "",
    }));
}

/**
 * Get the diff for a specific commit
 */
export async function getCommitDiff(
    owner: string,
    repo: string,
    commitSha: string
): Promise<string> {
    const { data } = await octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: commitSha,
        mediaType: {
            format: "diff",
        },
    });
    // When requesting diff format, data is returned as a string
    return data as unknown as string;
}

/**
 * Get a diff comparing two commits (base...head)
 */
export async function getCompareDiff(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string
): Promise<string> {
    const { data } = await octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: baseSha,
        head: headSha,
        mediaType: {
            format: "diff",
        },
    });
    return data as unknown as string;
}

/**
 * Compute incremental diff if this is a subsequent review.
 * Finds the last bot activity timestamp, matches it to a commit,
 * and fetches only the diff since that commit.
 * Mutates context to set incrementalDiff and lastReviewedCommitSha.
 * Falls back gracefully (leaves fields undefined) on any failure.
 */
export async function computeIncrementalDiff(context: PRContext): Promise<void> {
    // Skip if --full flag is set
    if (process.env.PR_AGENT_FULL_DIFF === "true") {
        console.log("--full flag set, using full PR diff");
        return;
    }

    try {
        // Debug: log bot identity and all authors for diagnostics
        console.log(`Bot login: "${context.botLogin}"`);
        const reviewAuthors = [...new Set(context.reviewSummaries.map(r => r.author))];
        const commentAuthors = [...new Set(context.conversation.map(c => c.author))];
        const inlineAuthors = [...new Set(context.existingComments.map(c => c.author))];
        if (reviewAuthors.length) console.log(`Review authors: ${reviewAuthors.join(', ')}`);
        if (commentAuthors.length) console.log(`Comment authors: ${commentAuthors.join(', ')}`);
        if (inlineAuthors.length) console.log(`Inline comment authors: ${inlineAuthors.join(', ')}`);

        const isBotAuthor = (author: string) => author === context.botLogin;

        // Find the latest bot activity across all three sources
        const botTimestamps: number[] = [];

        for (const r of context.reviewSummaries) {
            if (isBotAuthor(r.author) && r.submittedAt) {
                const t = new Date(r.submittedAt).getTime();
                if (!isNaN(t)) botTimestamps.push(t);
            }
        }

        for (const c of context.conversation) {
            if (isBotAuthor(c.author) && c.createdAt) {
                const t = new Date(c.createdAt).getTime();
                if (!isNaN(t)) botTimestamps.push(t);
            }
        }

        for (const c of context.existingComments) {
            if (isBotAuthor(c.author) && c.createdAt) {
                const t = new Date(c.createdAt).getTime();
                if (!isNaN(t)) botTimestamps.push(t);
            }
        }

        if (botTimestamps.length === 0) {
            console.log("No previous bot activity found, using full PR diff");
            return;
        }

        const lastBotActivityTime = Math.max(...botTimestamps);
        console.log(`Last bot activity: ${new Date(lastBotActivityTime).toISOString()}`);

        // Find the last commit at or before the bot's last activity
        let matchedCommit: { sha: string; date: string } | null = null;
        for (const commit of context.commits) {
            const commitTime = new Date(commit.date).getTime();
            if (!isNaN(commitTime) && commitTime <= lastBotActivityTime) {
                matchedCommit = commit;
            }
        }

        if (!matchedCommit) {
            console.log("No commit found at or before last bot activity (possible force push), using full PR diff");
            return;
        }

        // If the matched commit is HEAD, nothing changed since last review
        if (matchedCommit.sha === context.headSha) {
            console.log("No new commits since last bot activity, using full PR diff");
            return;
        }

        console.log(`Computing incremental diff: ${matchedCommit.sha.substring(0, 7)}..${context.headSha.substring(0, 7)}`);
        const incrementalDiff = await getCompareDiff(
            context.owner,
            context.repo,
            matchedCommit.sha,
            context.headSha,
        );

        context.incrementalDiff = incrementalDiff;
        context.lastReviewedCommitSha = matchedCommit.sha;
        console.log(`Incremental diff computed (since ${matchedCommit.sha.substring(0, 7)})`);
    } catch (error) {
        console.warn(
            "Failed to compute incremental diff, falling back to full PR diff:",
            error instanceof Error ? error.message : error,
        );
    }
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

/**
 * Add a reaction to an issue comment
 */
export async function addReactionToComment(
    owner: string,
    repo: string,
    commentId: number,
    reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
): Promise<void> {
    await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction,
    });
}

/**
 * Add a reaction to a PR review comment
 */
export async function addReactionToReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
): Promise<void> {
    await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction,
    });
}

/**
 * Review verdict labels used by the PR agent
 */
export const REVIEW_LABELS = {
    approve: "pr-agent: ✅ approved",
    request_changes: "pr-agent: ⚠️ changes requested",
    comment: "pr-agent: 💬 feedback",
} as const;

/**
 * Add a label to a PR, creating it if it doesn't exist
 */
export async function addLabelToPR(
    owner: string,
    repo: string,
    prNumber: number,
    label: string
): Promise<void> {
    // Ensure the label exists in the repo (create if not)
    try {
        await octokit.rest.issues.getLabel({
            owner,
            repo,
            name: label,
        });
    } catch (error: unknown) {
        // Only create label if it truly doesn't exist (404)
        const isNotFoundError = error && typeof error === "object" && "status" in error && error.status === 404;
        if (!isNotFoundError) {
            throw error;
        }
        // Label doesn't exist, create it
        const colors: Record<string, string> = {
            [REVIEW_LABELS.approve]: "0e8a16",      // green
            [REVIEW_LABELS.request_changes]: "fbca04", // yellow
            [REVIEW_LABELS.comment]: "1d76db",      // blue
        };
        await octokit.rest.issues.createLabel({
            owner,
            repo,
            name: label,
            color: colors[label] || "ededed",
        });
    }

    await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [label],
    });
}

/**
 * Remove a label from a PR (silently ignores if label not present)
 */
export async function removeLabelFromPR(
    owner: string,
    repo: string,
    prNumber: number,
    label: string
): Promise<void> {
    try {
        await octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: prNumber,
            name: label,
        });
    } catch (error: unknown) {
        // Only ignore if label wasn't on the PR (404)
        const isNotFoundError = error && typeof error === "object" && "status" in error && error.status === 404;
        if (!isNotFoundError) {
            throw error;
        }
    }
}

/**
 * Set the review verdict label on a PR, removing any previous review labels
 */
export async function setReviewLabel(
    owner: string,
    repo: string,
    prNumber: number,
    verdict: keyof typeof REVIEW_LABELS
): Promise<void> {
    // Remove all other review labels first
    const labelsToRemove = Object.values(REVIEW_LABELS).filter(
        (label) => label !== REVIEW_LABELS[verdict]
    );

    await Promise.all(
        labelsToRemove.map((label) => removeLabelFromPR(owner, repo, prNumber, label))
    );

    // Add the new label
    await addLabelToPR(owner, repo, prNumber, REVIEW_LABELS[verdict]);
}

/**
 * Dismiss previous approval/change request reviews by the bot on a PR
 */
async function dismissPreviousReviews(
    owner: string,
    repo: string,
    prNumber: number
): Promise<void> {
    try {
        // Resolve bot identity — skip dismissal if we can't identify ourselves
        const botLogin = await getBotLogin();
        if (botLogin === "unknown") {
            console.warn("Could not resolve bot login — skipping dismiss to avoid affecting other bots' reviews");
            return;
        }

        // List all reviews on the PR
        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
            owner,
            repo,
            pull_number: prNumber,
            per_page: 100,
        });

        // Find reviews by the bot that are APPROVED or CHANGES_REQUESTED
        const reviewsToDismiss = reviews.filter(
            (review) =>
                review.user?.login === botLogin &&
                (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
        );

        if (reviewsToDismiss.length === 0) {
            console.log(`No previous APPROVED/CHANGES_REQUESTED reviews found (bot login: "${botLogin}")`);
            return;
        }

        // Dismiss each review via GraphQL — REST dismissReview was not clearing status
        // https://docs.github.com/en/graphql/reference/mutations#dismisspullrequestreview
        for (const review of reviewsToDismiss) {
            try {
                await octokit.graphql(`
                    mutation($reviewId: ID!, $message: String!) {
                        dismissPullRequestReview(input: {
                            pullRequestReviewId: $reviewId,
                            message: $message
                        }) {
                            pullRequestReview { state }
                        }
                    }
                `, {
                    reviewId: review.node_id,
                    message: "Superseded by new review",
                });
                console.log(`✅ Dismissed previous ${review.state} review #${review.id}`);
            } catch (dismissError) {
                console.warn(`⚠️ Could not dismiss review #${review.id} (node_id: ${review.node_id}):`, dismissError instanceof Error ? dismissError.message : dismissError);
            }
        }
    } catch (error) {
        console.warn(`⚠️ Could not check/dismiss previous reviews:`, error instanceof Error ? error.message : error);
    }
}

/**
 * Check if a review with the given body was recently created on this PR.
 * Used to avoid posting a duplicate comment when createReview throws
 * but the review was actually created server-side.
 */
async function wasReviewCreated(
    owner: string,
    repo: string,
    prNumber: number,
    expectedBody: string
): Promise<boolean> {
    try {
        const { data: reviews } = await octokit.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: prNumber,
            per_page: 100,
        });
        // API returns oldest-first; check the most recent reviews
        return reviews.slice(-5).some((r) => r.body === expectedBody);
    } catch {
        // If we can't verify, err on the side of not posting a duplicate
        return true;
    }
}

/**
 * Submit a PR review with approval, request changes, or comment
 * This creates an actual GitHub review (not just a comment)
 * Falls back to a regular comment if the review fails and wasn't created server-side
 */
export async function submitPRReview(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    commitId?: string
): Promise<void> {
    // If submitting a COMMENT review, dismiss any previous approvals/change requests
    // since a COMMENT review doesn't clear a prior approval or rejection on its own.
    if (event === "COMMENT") {
        await dismissPreviousReviews(owner, repo, prNumber);
    }

    const params: Parameters<Octokit["rest"]["pulls"]["createReview"]>[0] = {
        owner,
        repo,
        pull_number: prNumber,
        body,
        event,
    };

    // Include commit_id if provided (recommended for accuracy)
    if (commitId) {
        params.commit_id = commitId;
    }

    try {
        await octokit.rest.pulls.createReview(params);
    } catch (error) {
        console.warn(
            `⚠️ Could not submit review as ${event}:`,
            error instanceof Error ? error.message : error
        );

        // Check if the review was actually created despite the error
        const reviewCreated = await wasReviewCreated(owner, repo, prNumber, body);
        if (!reviewCreated) {
            console.warn(`⚠️ Review was not created, falling back to comment`);
            await createPRComment(owner, repo, prNumber, body);
        } else {
            console.warn(`⚠️ Review was created despite the error — skipping fallback comment`);
        }
    }
}
