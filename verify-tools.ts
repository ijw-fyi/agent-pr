import { tools } from "./src/tools/index.js";

const grepTool = tools.find(t => t.name === "grep");

if (grepTool) {
    console.log("SUCCESS: grep tool is registered and available.");
} else {
    console.error("FAILURE: grep tool is NOT found in the tools list.");
    process.exit(1);
}
