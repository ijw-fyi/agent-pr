/**
 * Version helper - reads version from package.json
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Read version at module load time
let version = "unknown";
try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Try multiple possible locations for package.json
    const possiblePaths = [
        join(__dirname, "..", "..", "package.json"),  // dist/helpers -> root
        join(__dirname, "..", "package.json"),        // action -> root
        join(__dirname, "package.json"),              // action/package.json (bundled by ncc)
        join(process.cwd(), "package.json"),          // cwd fallback
    ];

    for (const packagePath of possiblePaths) {
        try {
            const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
            if (packageJson.version) {
                version = packageJson.version;
                break;
            }
        } catch {
            // Try next path
        }
    }
} catch {
    // Complete fallback
    version = "UNKNOWN";
}

export function getVersion(): string {
    return version;
}
