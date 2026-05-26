/**
 * tools/pkanalix.js
 * PKanalix NCA MCP tool definitions via lixoftConnectors.
 */

import { z } from "zod";

const toJson = (rExpr) =>
  `cat(jsonlite::toJSON(${rExpr}, auto_unbox=TRUE, digits=6, na="null"))`;

export function registerPKanalixTools(server, pool) {
  // ── 1. Load PKanalix project ─────────────────────────────────────────────
  server.tool(
    "pkanalix_load_project",
    "Load a PKanalix project (.pkax) for NCA analysis.",
    { path: z.string().describe("Absolute path to .pkax project file") },
    async ({ path }) => {
      const s = await pool.get("pkanalix");
      const out = await s.run(`
loadProject("${path}")
cat("PKanalix project loaded:", "${path}")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 2. Run NCA ───────────────────────────────────────────────────────────
  server.tool(
    "pkanalix_run_nca",
    "Execute Non-Compartmental Analysis (NCA) on the loaded dataset.",
    {
      dose_interval: z
        .number()
        .optional()
        .describe("Tau (dose interval) in hours for AUCtau at steady state"),
    },
    async ({ dose_interval }) => {
      const s = await pool.get("pkanalix");
      const tauLine = dose_interval
        ? `setNcaParameters(list(tau=${dose_interval}))`
        : "";
      const out = await s.run(`
${tauLine}
runScenario()
cat("NCA complete.")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 3. Get NCA results ───────────────────────────────────────────────────
  server.tool(
    "pkanalix_get_results",
    "Return NCA-derived PK parameters (AUC, Cmax, Tmax, t1/2, CL/F, Vz/F) per subject.",
    {
      parameters: z
        .array(z.string())
        .optional()
        .describe("Specific NCA parameters to return. Omit for all."),
    },
    async ({ parameters }) => {
      const s = await pool.get("pkanalix");
      const out = await s.run(`
res <- getNCAIndividualParameters()
${
  parameters && parameters.length > 0
    ? `res <- res[, c("id", ${parameters.map((p) => `"${p}"`).join(", ")}), drop=FALSE]`
    : ""
}
${toJson("res")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 4. Get NCA summary statistics ────────────────────────────────────────
  server.tool(
    "pkanalix_get_summary",
    "Return summary statistics (geometric mean, CV%, 90% CI) for all NCA parameters.",
    {},
    async () => {
      const s = await pool.get("pkanalix");
      const out = await s.run(`
res  <- getNCAIndividualParameters()
num  <- res[, sapply(res, is.numeric), drop=FALSE]
smry <- data.frame(
  parameter = names(num),
  n         = sapply(num, function(x) sum(!is.na(x))),
  geom_mean = sapply(num, function(x) exp(mean(log(x[x>0]), na.rm=TRUE))),
  cv_pct    = sapply(num, function(x) sd(x, na.rm=TRUE)/mean(x, na.rm=TRUE)*100),
  ci90_lo   = sapply(num, function(x) quantile(x, 0.05, na.rm=TRUE)),
  ci90_hi   = sapply(num, function(x) quantile(x, 0.95, na.rm=TRUE))
)
${toJson("smry")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 5. Get dose-normalized NCA parameters ────────────────────────────────
  server.tool(
    "pkanalix_dose_normalized",
    "Return dose-normalized AUC and Cmax for linearity assessment.",
    {},
    async () => {
      const s = await pool.get("pkanalix");
      const out = await s.run(`
res <- getNCAIndividualParameters()
dose_cols <- grep("dose", names(res), value=TRUE, ignore.case=TRUE)
if (length(dose_cols) > 0 && "AUClast" %in% names(res)) {
  dose_col <- dose_cols[1]
  res$AUC_norm  <- res$AUClast / res[[dose_col]]
  res$Cmax_norm <- res$Cmax   / res[[dose_col]]
  ${toJson('res[, c("id", dose_col, "AUClast", "Cmax", "AUC_norm", "Cmax_norm")]')}
} else {
  cat("Dose column or AUClast not found in NCA results.")
}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 6. Export NCA results to CSV ─────────────────────────────────────────
  server.tool(
    "pkanalix_export_csv",
    "Export full NCA results table to a CSV file.",
    {
      output_path: z
        .string()
        .describe("Path for output CSV file"),
    },
    async ({ output_path }) => {
      const s = await pool.get("pkanalix");
      const out = await s.run(`
res <- getNCAIndividualParameters()
write.csv(res, "${output_path}", row.names=FALSE)
cat("Exported", nrow(res), "subjects to:", "${output_path}")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );
}
