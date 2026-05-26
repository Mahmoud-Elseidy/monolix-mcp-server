/**
 * src/index.js
 * monolix-mcp — Main entry point.
 * Registers all tools and starts the stdio MCP transport.
 *
 * Usage:
 *   node src/index.js
 *   LIXOFT_HOME=/path/to/MonolixSuite node src/index.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

import { SessionPool } from "./r-session.js";
import { registerMonolixTools } from "./tools/monolix.js";
import { registerSimulxTools } from "./tools/simulx.js";
import { registerPKanalixTools } from "./tools/pkanalix.js";
import { registerRsmlxTools } from "./tools/rsmlx.js";
import { registerUtilityTools } from "./tools/utils.js";

// ─── Configuration ────────────────────────────────────────────────────────────

// Detect the newest installed MonolixSuite across one or more parent dirs.
// MonolixSuite may live under Program Files\Lixoft or ProgramData\Lixoft.
function detectMonolixHome(parents) {
  const found = [];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const d of readdirSync(parent)) {
      if (/^MonolixSuite/.test(d)) {
        found.push({ name: d, path: join(parent, d).replace(/\\/g, "/") });
      }
    }
  }
  // Newest by version-aware comparison on the SUITE NAME (not the full path,
  // so "Program Files/...2024R1" beats "ProgramData/...2023R1").
  found.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  return found.length > 0 ? found[0].path : null;
}

const WIN_LIXOFT_PARENTS = [
  "C:/Program Files/Lixoft",
  "C:/ProgramData/Lixoft",
];

const LIXOFT_HOME =
  process.env.LIXOFT_HOME ||
  (process.platform === "win32"
    ? detectMonolixHome(WIN_LIXOFT_PARENTS) ||
      "C:/Program Files/Lixoft/MonolixSuite2024R1"
    : process.platform === "darwin"
    ? detectMonolixHome(["/Applications"]) || "/Applications/MonolixSuite2024R1"
    : detectMonolixHome(["/opt"]) || "/opt/MonolixSuite2024R1");

// ─── Server bootstrap ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "monolix-mcp",
  version: "1.0.0",
});

// One persistent R session per Lixoft software target
const pool = new SessionPool(LIXOFT_HOME);

// Register all tool groups
registerMonolixTools(server, pool);
registerSimulxTools(server, pool);
registerPKanalixTools(server, pool);
registerRsmlxTools(server, pool);
registerUtilityTools(server, pool);

// ─── Startup & transport ──────────────────────────────────────────────────────

const transport = new StdioServerTransport();

process.on("SIGINT", () => {
  pool.stopAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  pool.stopAll();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[monolix-mcp] Uncaught: ${err.message}\n`);
});

process.stderr.write(
  `[monolix-mcp] Starting. LIXOFT_HOME=${LIXOFT_HOME}\n`
);

await server.connect(transport);
