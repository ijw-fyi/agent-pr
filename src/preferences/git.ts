import { simpleGit, SimpleGit } from "simple-git";
import { getOctokit } from "../context/github.js";

const PREFERENCES_BRANCH = "__agent_pr__";
const PREFERENCES_FILE = "preferences.txt";

let git: SimpleGit;

/**
 * Initialize the git client
 */
export function initGit(workingDir: string = process.cwd()): void {
    git = simpleGit(workingDir);
}

/**
 * Read preferences from the __agent_pr__ branch.
 * Uses GitHub API to read from the branch without checking it out.
 * Returns empty string if branch or file doesn't exist.
 */
export async function readPreferences(
    owner: string,
    repo: string
): Promise<string> {
    const octokit = getOctokit();

    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: PREFERENCES_FILE,
            ref: PREFERENCES_BRANCH,
        });

        if ("content" in data && data.type === "file") {
            return Buffer.from(data.content, "base64").toString("utf-8");
        }
        return "";
    } catch (error) {
        // Branch or file doesn't exist yet - handle various error patterns
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (
                msg.includes("not found") ||
                msg.includes("no commit found") ||
                msg.includes("404")
            ) {
                return "";
            }
        }
        throw error;
    }
}


/**
 * Write preferences to the __agent_pr__ branch.
 * Creates the branch as an orphan if it doesn't exist.
 * Uses GitHub API to commit directly without local checkout.
 */
export async function writePreferences(
    owner: string,
    repo: string,
    content: string,
    message: string = "Update preferences"
): Promise<void> {
    const octokit = getOctokit();

    // Try to get the current file SHA (needed for updates)
    let fileSha: string | undefined;
    let branchExists = true;

    try {
        const { data: refData } = await octokit.rest.git.getRef({
            owner,
            repo,
            ref: `heads/${PREFERENCES_BRANCH}`,
        });
        // Branch exists, try to get file SHA
        try {
            const { data } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: PREFERENCES_FILE,
                ref: PREFERENCES_BRANCH,
            });
            if ("sha" in data) {
                fileSha = data.sha;
            }
        } catch {
            // File doesn't exist yet, that's fine
        }
    } catch {
        // Branch doesn't exist
        branchExists = false;
    }

    if (!branchExists) {
        // Create orphan branch with the preferences file
        await createOrphanBranch(owner, repo, content, message);
    } else {
        // Update the file on the existing branch
        await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: PREFERENCES_FILE,
            message,
            content: Buffer.from(content).toString("base64"),
            branch: PREFERENCES_BRANCH,
            sha: fileSha,
        });
    }
}

/**
 * Create an orphan branch with just the preferences file.
 * This creates a branch with no history connection to the main repo.
 */
async function createOrphanBranch(
    owner: string,
    repo: string,
    content: string,
    message: string
): Promise<void> {
    const octokit = getOctokit();

    // Create a blob for the file content
    const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
    });

    // Create a tree with just this file
    const { data: tree } = await octokit.rest.git.createTree({
        owner,
        repo,
        tree: [
            {
                path: PREFERENCES_FILE,
                mode: "100644",
                type: "blob",
                sha: blob.sha,
            },
        ],
    });

    // Create a commit with no parent (orphan)
    const { data: commit } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.sha,
        // No parents = orphan commit
    });

    // Create the branch pointing to this commit
    await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${PREFERENCES_BRANCH}`,
        sha: commit.sha,
    });
}

/**
 * Append a preference to the existing preferences.
 * Handles the case where no preferences exist yet.
 */
export async function appendPreference(
    owner: string,
    repo: string,
    preference: string
): Promise<void> {
    const currentPreferences = await readPreferences(owner, repo);

    const trimmedPreference = preference.trim();
    const updatedContent = currentPreferences
        ? currentPreferences.trimEnd() + "\n" + trimmedPreference + "\n"
        : trimmedPreference + "\n";

    await writePreferences(
        owner,
        repo,
        updatedContent,
        `Add preference: ${trimmedPreference.substring(0, 50)}${trimmedPreference.length > 50 ? '...' : ''}`
    );
}

export { PREFERENCES_BRANCH, PREFERENCES_FILE };
