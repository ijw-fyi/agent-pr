import { getOctokit } from "../context/github.js";
import type { PreferenceContext } from "../agents/code-comment/index.js";

/**
 * Gather context for the preference agent from a comment reply
 */
export async function gatherPreferenceContext(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number
): Promise<PreferenceContext | null> {
    const octokit = getOctokit();

    // Get the comment that was replied to
    const { data: comment } = await octokit.rest.pulls.getReviewComment({
        owner,
        repo,
        comment_id: commentId,
    });

    if (!comment.in_reply_to_id && !comment.body) {
        console.log("Comment is not a reply or has no body");
        return null;
    }

    // Get all review comments on this PR
    const { data: allComments } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
    });

    // Build the comment chain
    // Find the root comment and all replies
    const rootCommentId = comment.in_reply_to_id || comment.id;
    const rootComment = allComments.find((c) => c.id === rootCommentId);

    if (!rootComment) {
        console.log("Could not find root comment");
        return null;
    }

    // Get all comments in this thread (root + replies)
    const threadComments = allComments
        .filter((c) => c.id === rootCommentId || c.in_reply_to_id === rootCommentId)
        .sort(
            (a, b) =>
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

    // Build comment chain
    const commentChain = threadComments.map((c) => ({
        author: c.user?.login || "unknown",
        body: c.body,
        isBot: c.user?.type === "Bot",
    }));

    // Get the code snippet around the commented line
    const codeSnippet = rootComment.diff_hunk || "(no diff available)";

    return {
        owner,
        repo,
        filePath: rootComment.path,
        codeSnippet,
        commentChain,
    };
}
