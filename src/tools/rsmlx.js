/**
 * tools/rsmlx.js
 * Rsmlx MCP tools: automated PopPK model building via buildmlx, confintmlx.
 * Rsmlx runs on top of a loaded Monolix project (same R session).
 */

import { z } from "zod";

const toJson = (rExpr) =>
  `cat(jsonlite::toJSON(${rExpr}, auto_unbox=TRUE, digits=6, na="null"))`;

export function registerRsmlxTools(server, pool) {
  // ── 1. Auto covariate & variability building ─────────────────────────────
  server.tool(
    "rsmlx_buildmlx",
    "Automated stepwise covariate and IIV model building using Rsmlx::buildmlx(). Requires a loaded and estimated Monolix project.",
    {
      covariate_search: z
        .boolean()
        .default(true)
        .describe("Run covariate search"),
      variability_search: z
        .boolean()
        .default(true)
        .describe("Run IIV (random effect) search"),
      correlation_search: z
        .boolean()
        .default(false)
        .describe("Run correlation structure search"),
      p_value: z
        .number()
        .default(0.05)
        .describe("Significance threshold for covariate inclusion (likelihood ratio test)"),
      method: z
        .enum(["COSSAC", "SCM"])
        .default("COSSAC")
        .describe("Model building algorithm"),
    },
    async ({ covariate_search, variability_search, correlation_search, p_value, method }) => {
      const s = await pool.get("monolix");
      const out = await s.run(`
library(Rsmlx)
result <- buildmlx(
  covariateSearch   = ${covariate_search ? "TRUE" : "FALSE"},
  variabilitySearch = ${variability_search ? "TRUE" : "FALSE"},
  correlationSearch = ${correlation_search ? "TRUE" : "FALSE"},
  p.value           = ${p_value},
  method            = "${method}"
)
${toJson("result")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 2. Profile likelihood confidence intervals ────────────────────────────
  server.tool(
    "rsmlx_confintmlx",
    "Compute profile likelihood confidence intervals for population parameters (more accurate than asymptotic SE-based CIs).",
    {
      parameters: z
        .array(z.string())
        .optional()
        .describe("Parameter names to compute CIs for. Omit for all fixed effects."),
      level: z
        .number()
        .default(0.95)
        .describe("Confidence level (default 0.95 for 95% CI)"),
    },
    async ({ parameters, level }) => {
      const s = await pool.get("monolix");
      const paramArg = parameters && parameters.length > 0
        ? `parameter = c(${parameters.map((p) => `"${p}"`).join(", ")}),`
        : "";
      const out = await s.run(`
library(Rsmlx)
ci <- confintmlx(
  ${paramArg}
  level = ${level}
)
${toJson("ci")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 3. Model evaluation / goodness of fit metrics ─────────────────────────
  server.tool(
    "rsmlx_llp",
    "Run log-likelihood profiling (LLP) to assess parameter identifiability.",
    {
      parameters: z
        .array(z.string())
        .optional()
        .describe("Parameters to profile. Omit for all."),
    },
    async ({ parameters }) => {
      const s = await pool.get("monolix");
      const paramArg = parameters && parameters.length > 0
        ? `parameter = c(${parameters.map((p) => `"${p}"`).join(", ")})`
        : "";
      const out = await s.run(`
library(Rsmlx)
llp_result <- llp(${paramArg})
${toJson("llp_result")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 4. Run automatic model selection ─────────────────────────────────────
  server.tool(
    "rsmlx_automatic_model",
    "Fully automated PopPK model building: structural model, IIV, covariate, and error model selection.",
    {
      structural_models: z
        .array(z.string())
        .optional()
        .describe("List of structural model names to compare (Lixoft library models). Omit to use current model only."),
      criterion: z
        .enum(["BICc", "BIC", "AIC"])
        .default("BICc")
        .describe("Model selection criterion"),
    },
    async ({ structural_models, criterion }) => {
      const s = await pool.get("monolix");

      let modelCompareCode = "";
      if (structural_models && structural_models.length > 0) {
        const modelList = structural_models.map((m) => `"${m}"`).join(", ");
        modelCompareCode = `
# Compare structural models by criterion
models <- c(${modelList})
criteria_list <- lapply(models, function(m) {
  setStructuralModel(m)
  runMonolix(tasks = list(populationParameterEstimation=TRUE, logLikelihoodEstimation=TRUE))
  ll <- getLogLikelihood()
  data.frame(model=m, AIC=ll$AIC, BIC=ll$BIC, BICc=ll$BICc)
})
criteria_df <- do.call(rbind, criteria_list)
best_model <- criteria_df$model[which.min(criteria_df[["${criterion}"]])]
setStructuralModel(best_model)
cat("Best structural model:", best_model, "\\n")
`;
      }

      const out = await s.run(`
library(Rsmlx)
${modelCompareCode}
full_result <- buildmlx(
  covariateSearch   = TRUE,
  variabilitySearch = TRUE,
  correlationSearch = TRUE
)
${toJson("full_result")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 5. Stepwise covariate model building summary ──────────────────────────
  server.tool(
    "rsmlx_covariate_summary",
    "Return a summary table of the stepwise covariate selection process (which covariates were added/removed at each step and why).",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(`
library(Rsmlx)
# Re-run covariate search with verbose output captured
result <- buildmlx(covariateSearch=TRUE, variabilitySearch=FALSE, correlationSearch=FALSE)
if (!is.null(result$covariate)) {
  ${toJson("result$covariate")}
} else {
  cat("No covariate search results available. Run rsmlx_buildmlx first.")
}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );
}
