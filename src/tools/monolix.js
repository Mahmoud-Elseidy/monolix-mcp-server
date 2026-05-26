/**
 * tools/monolix.js
 * All Monolix-specific MCP tool definitions.
 * Each tool returns { content: [{ type: "text", text }] }
 */

import { z } from "zod";

// ─── helpers ─────────────────────────────────────────────────────────────────

const toJson = (rExpr) =>
  `cat(jsonlite::toJSON(${rExpr}, auto_unbox=TRUE, digits=6, na="null"))`;

// ─── tool registry ────────────────────────────────────────────────────────────

export function registerMonolixTools(server, pool) {
  // ── 1. Load project ──────────────────────────────────────────────────────
  server.tool(
    "monolix_load_project",
    "Load a Monolix .mlxtran project file. Must be called before any other Monolix tool.",
    { path: z.string().describe("Absolute path to .mlxtran project file") },
    async ({ path }) => {
      const s = await pool.get("monolix");
      const out = await s.run(`
loadProject("${path}")
cat(jsonlite::toJSON(list(
  project = getProjectSettings()$project,
  data    = getData()$dataFile,
  model   = getStructuralModel()
), auto_unbox=TRUE))
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 2. Get project settings ──────────────────────────────────────────────
  server.tool(
    "monolix_get_project_info",
    "Return current project metadata: name, data file, model file, structural model.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(`
d <- getData()
${toJson("list(project=getProjectSettings()$project, dataFile=d$dataFile, model=getStructuralModel(), headers=d$header, headerTypes=d$headerTypes)")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 3. Set structural model ──────────────────────────────────────────────
  server.tool(
    "monolix_set_structural_model",
    "Change the structural PK/PD model (mlxtran model file path or built-in library model name).",
    {
      model: z.string().describe("Path to .txt mlxtran model or Lixoft library model name (e.g. 'lib:PK_1cpt_oral')"),
    },
    async ({ model }) => {
      const s = await pool.get("monolix");
      const out = await s.run(`setStructuralModel("${model}"); cat("Model set:", "${model}")`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 4. Set covariate model ───────────────────────────────────────────────
  server.tool(
    "monolix_set_covariate_model",
    "Define which covariates act on which parameters and their transformation type.",
    {
      covariate_model: z.array(
        z.object({
          parameter: z.string().describe("PK parameter name, e.g. 'Cl'"),
          covariate: z.string().describe("Covariate name, e.g. 'WT'"),
          type: z.enum(["continuous", "categorical"]).default("continuous"),
        })
      ).describe("List of covariate-parameter links"),
    },
    async ({ covariate_model }) => {
      const s = await pool.get("monolix");
      // Build R list: list(list(name="Cl", covariate="WT", type="continuous"), ...)
      const rList = covariate_model
        .map(
          (c) =>
            `list(name="${c.parameter}", covariate="${c.covariate}", type="${c.type}")`
        )
        .join(",\n  ");
      const out = await s.run(`
setCovariateModel(list(
  ${rList}
))
cat("Covariate model updated.")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 5. Set individual variability model ─────────────────────────────────
  server.tool(
    "monolix_set_variability_model",
    "Set random effects (IIV) for each PK/PD parameter.",
    {
      variability: z.array(
        z.object({
          parameter: z.string().describe("Parameter name, e.g. 'Cl'"),
          iiv: z.boolean().describe("Include IIV for this parameter"),
          distribution: z
            .enum(["logNormal", "normal", "logitNormal", "probitNormal"])
            .default("logNormal"),
        })
      ),
    },
    async ({ variability }) => {
      const s = await pool.get("monolix");
      const rList = variability
        .map(
          (v) =>
            `list(name="${v.parameter}", variability=${v.iiv ? "TRUE" : "FALSE"}, distribution="${v.distribution}")`
        )
        .join(",\n  ");
      const out = await s.run(`
setIndividualParameterVariability(list(
  ${rList}
))
cat("Variability model updated.")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 6. Set initial estimates ─────────────────────────────────────────────
  server.tool(
    "monolix_set_initial_estimates",
    "Set initial population parameter estimates before running SAEM.",
    {
      estimates: z
        .record(z.number())
        .describe("Named list of parameter initial values, e.g. {Cl_pop: 5, V_pop: 50}"),
    },
    async ({ estimates }) => {
      const s = await pool.get("monolix");
      const rList = Object.entries(estimates)
        .map(([k, v]) => `"${k}" = ${v}`)
        .join(", ");
      const out = await s.run(`
setPopulationParameterInformation(list(${rList}))
cat("Initial estimates set.")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 7. Run Monolix ───────────────────────────────────────────────────────
  server.tool(
    "monolix_run",
    "Run Monolix estimation tasks. Defaults to all tasks if none specified.",
    {
      tasks: z
        .array(
          z.enum([
            "populationParameterEstimation",
            "conditionalModeEstimation",
            "conditionalDistributionSampling",
            "standardErrorEstimation",
            "logLikelihoodEstimation",
            "plots",
          ])
        )
        .optional()
        .describe("Tasks to run. Omit to run all."),
    },
    async ({ tasks }) => {
      const s = await pool.get("monolix");
      const taskArg = tasks
        ? `list(${tasks.map((t) => `${t}=TRUE`).join(", ")})`
        : "NULL";
      const out = await s.run(`
scenario <- getScenario()
${tasks ? `scenario$tasks <- ${taskArg}; setScenario(scenario)` : ""}
runScenario()
cat("Estimation complete.")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 8. Get population parameter estimates ────────────────────────────────
  server.tool(
    "monolix_get_estimates",
    "Return estimated population parameters (fixed effects and IIV) with SE and RSE.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(`
pop  <- getEstimatedPopulationParameters()
se   <- tryCatch(getEstimatedStandardErrors(), error=function(e) NULL)
res  <- list(population_parameters = pop)
if (!is.null(se)) res$standard_errors <- se
${toJson("res")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 9. Get individual estimates ──────────────────────────────────────────
  server.tool(
    "monolix_get_individual_estimates",
    "Return EBE (mode) individual parameter estimates for all subjects.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(toJson("getEstimatedIndividualParameters()$saem"));
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 10. Get log-likelihood & criteria ────────────────────────────────────
  server.tool(
    "monolix_get_llx",
    "Return log-likelihood, AIC, BIC, and BICc for model comparison.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(toJson("getEstimatedLogLikelihood()"));
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 11. Get convergence diagnostics ──────────────────────────────────────
  server.tool(
    "monolix_get_convergence",
    "Return SAEM convergence data for all population parameters across iterations.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(`
conv <- getSAEMiterations()
# Return last 10 iterations summary per parameter
${toJson("conv")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 12. Get GOF residuals ─────────────────────────────────────────────────
  server.tool(
    "monolix_get_residuals",
    "Return IWRES and NPDE residuals for goodness-of-fit assessment.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(`
res <- getChartsDataResidualsScatterPlot()
${toJson("res")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 13. Get observed vs predicted ────────────────────────────────────────
  server.tool(
    "monolix_get_obs_pred",
    "Return observed, individual predicted, and population predicted concentrations.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(`
pred <- getChartsDataObsPred()
${toJson("pred")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 14. Save project ─────────────────────────────────────────────────────
  server.tool(
    "monolix_save_project",
    "Save the current Monolix project. Optionally save to a new path.",
    { path: z.string().optional().describe("New save path. Omit to overwrite current project.") },
    async ({ path }) => {
      const s = await pool.get("monolix");
      const cmd = path ? `saveProject("${path}")` : `saveProject()`;
      const out = await s.run(`${cmd}; cat("Project saved.")`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 15. Get random effects (eta) ─────────────────────────────────────────
  server.tool(
    "monolix_get_random_effects",
    "Return estimated random effects (eta) for each individual and parameter.",
    {},
    async () => {
      const s = await pool.get("monolix");
      const out = await s.run(toJson("getEstimatedRandomEffects()$saem"));
      return { content: [{ type: "text", text: out }] };
    }
  );
}
