/**
 * tools/simulx.js
 * Simulx MCP tool definitions — clinical trial simulation via lixoftConnectors.
 */

import { z } from "zod";

const toJson = (rExpr) =>
  `cat(jsonlite::toJSON(${rExpr}, auto_unbox=TRUE, digits=6, na="null"))`;

export function registerSimulxTools(server, pool) {
  // ── 1. Load Simulx project ───────────────────────────────────────────────
  server.tool(
    "simulx_load_project",
    "Load a Simulx project (.smlx) or initialize from a Monolix results folder.",
    {
      path: z
        .string()
        .describe("Path to .smlx project or Monolix results directory"),
      from_monolix: z
        .boolean()
        .default(false)
        .describe("If true, initialize Simulx from a Monolix results folder"),
    },
    async ({ path, from_monolix }) => {
      const s = await pool.get("simulx");
      const cmd = from_monolix
        ? `initmlx(model = "${path}")`
        : `loadProject("${path}")`;
      const out = await s.run(`${cmd}; cat("Simulx project loaded.")`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 2. Define population ─────────────────────────────────────────────────
  server.tool(
    "simulx_define_population",
    "Define a virtual population for simulation (N subjects, covariate distributions).",
    {
      n: z.number().int().positive().describe("Number of virtual subjects"),
      covariates: z
        .array(
          z.object({
            name: z.string().describe("Covariate name, e.g. 'WT'"),
            distribution: z
              .enum(["normal", "logNormal", "uniform", "fixed"])
              .default("normal"),
            mean: z.number().optional().describe("Mean (for normal/logNormal)"),
            sd: z.number().optional().describe("SD (for normal/logNormal)"),
            min: z.number().optional().describe("Min (for uniform)"),
            max: z.number().optional().describe("Max (for uniform)"),
            value: z.number().optional().describe("Fixed value"),
          })
        )
        .optional()
        .describe("Covariate definitions. Omit to use model defaults."),
    },
    async ({ n, covariates }) => {
      const s = await pool.get("simulx");

      let covCode = "";
      if (covariates && covariates.length > 0) {
        const covList = covariates.map((c) => {
          if (c.distribution === "fixed")
            return `list(name="${c.name}", distribution=list(type="fixed", value=${c.value}))`;
          if (c.distribution === "uniform")
            return `list(name="${c.name}", distribution=list(type="uniform", parameters=list(min=${c.min}, max=${c.max})))`;
          return `list(name="${c.name}", distribution=list(type="${c.distribution}", parameters=list(mean=${c.mean}, sd=${c.sd})))`;
        });
        covCode = `setCovariateElements(list(${covList.join(",\n  ")}))`;
      }

      const out = await s.run(`
setPopulationElements(list(list(name="pop1", N=${n})))
${covCode}
cat("Population defined: N =", ${n})
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 3. Define dosing regimen ─────────────────────────────────────────────
  server.tool(
    "simulx_define_regimen",
    "Define a dosing regimen for simulation (dose, interval, duration, route).",
    {
      amount: z.number().describe("Dose amount"),
      times: z
        .array(z.number())
        .describe("Dosing times in hours, e.g. [0, 24, 48]"),
      tinf: z
        .number()
        .optional()
        .describe("Infusion duration in hours (omit for bolus/oral)"),
      target: z
        .string()
        .optional()
        .default("Ad")
        .describe("Dose target compartment, e.g. 'Ad' (depot), 'Ac' (central)"),
      regimen_name: z.string().default("reg1").describe("Regimen identifier"),
    },
    async ({ amount, times, tinf, target, regimen_name }) => {
      const s = await pool.get("simulx");
      const tinfLine = tinf ? `, Tinf=${tinf}` : "";
      const timesR = `c(${times.join(",")})`;
      const out = await s.run(`
setTreatmentElements(list(list(
  name   = "${regimen_name}",
  amount = ${amount},
  time   = ${timesR},
  target = "${target}"
  ${tinfLine}
)))
cat("Regimen '${regimen_name}' defined: dose=${amount}, times=[${times.join(",")}]")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 4. Define output grid ────────────────────────────────────────────────
  server.tool(
    "simulx_define_output",
    "Define the PK/PD output observation grid for simulation.",
    {
      times: z
        .union([
          z.array(z.number()).describe("Explicit time points"),
          z.object({
            start: z.number(),
            end: z.number(),
            step: z.number(),
          }).describe("Regular grid: {start, end, step}"),
        ])
        .describe("Observation times"),
      variable: z
        .string()
        .default("Cc")
        .describe("Output variable name, e.g. 'Cc' (central concentration)"),
      output_name: z.string().default("out1"),
    },
    async ({ times, variable, output_name }) => {
      const s = await pool.get("simulx");
      const timesR = Array.isArray(times)
        ? `c(${times.join(",")})`
        : `seq(${times.start}, ${times.end}, by=${times.step})`;
      const out = await s.run(`
setOutputElements(list(list(
  name     = "${output_name}",
  element  = "${variable}",
  time     = ${timesR}
)))
cat("Output '${output_name}' defined for variable '${variable}'")
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 5. Run simulation ────────────────────────────────────────────────────
  server.tool(
    "simulx_run",
    "Execute the Simulx simulation with the currently defined population, regimen, and output.",
    {
      n_replications: z
        .number()
        .int()
        .positive()
        .default(1)
        .describe("Number of Monte Carlo replications"),
    },
    async ({ n_replications }) => {
      const s = await pool.get("simulx");
      const out = await s.run(`
setNbReplicates(${n_replications})
runSimulx()
cat("Simulation complete. Replications:", ${n_replications})
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 6. Get simulation results ────────────────────────────────────────────
  server.tool(
    "simulx_get_results",
    "Return simulated concentration-time profiles for all subjects.",
    {
      output_name: z.string().default("out1").describe("Output element name"),
      summary: z
        .boolean()
        .default(false)
        .describe("If true, return percentile summary (5th/50th/95th) instead of individual profiles"),
    },
    async ({ output_name, summary }) => {
      const s = await pool.get("simulx");
      const out = await s.run(`
res <- getSimulationResults()$${output_name}
${
  summary
    ? `
library(dplyr)
smry <- res |>
  dplyr::group_by(time) |>
  dplyr::summarise(
    p05 = quantile(${output_name}, 0.05),
    p50 = quantile(${output_name}, 0.50),
    p95 = quantile(${output_name}, 0.95),
    .groups = "drop"
  )
${toJson("smry")}
`
    : toJson("res")
}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 7. Compute exposure metrics ──────────────────────────────────────────
  server.tool(
    "simulx_get_exposure",
    "Compute AUC, Cmax, Cmin, Ctrough and target attainment for the simulated population.",
    {
      target_min: z
        .number()
        .optional()
        .describe("Lower therapeutic target (e.g. MIC or trough target)"),
      target_max: z
        .number()
        .optional()
        .describe("Upper therapeutic target (toxicity threshold)"),
      output_name: z.string().default("out1"),
      variable: z.string().default("Cc"),
      dose_interval: z.number().default(24).describe("Dose interval in hours for AUCtau"),
    },
    async ({ target_min, target_max, output_name, variable, dose_interval }) => {
      const s = await pool.get("simulx");
      const out = await s.run(`
library(dplyr)
res  <- getSimulationResults()$${output_name}
# Steady-state window: last dose interval
t_max <- max(res$time)
t_ss  <- t_max - ${dose_interval}
ss    <- res |> dplyr::filter(time >= t_ss)

expo <- ss |>
  dplyr::group_by(id) |>
  dplyr::summarise(
    Cmax   = max(${variable}),
    Cmin   = min(${variable}),
    Ctrough = dplyr::last(${variable}),
    AUCtau = sum(diff(time) * (${variable}[-dplyr::n()] + ${variable}[-1]) / 2),
    .groups = "drop"
  )

summary_stats <- expo |>
  dplyr::summarise(across(Cmax:AUCtau, list(
    median = ~median(.x),
    p05    = ~quantile(.x, 0.05),
    p95    = ~quantile(.x, 0.95)
  )))

result <- list(per_subject = expo, summary = summary_stats)

${
  target_min !== undefined
    ? `
ta <- expo |>
  dplyr::summarise(
    pct_above_min = mean(Ctrough >= ${target_min}) * 100,
    ${target_max !== undefined ? `pct_below_max = mean(Cmax <= ${target_max}) * 100,` : ""}
    pct_in_range  = ${target_max !== undefined ? `mean(Ctrough >= ${target_min} & Cmax <= ${target_max}) * 100` : "mean(Ctrough >= ${target_min}) * 100"}
  )
result$target_attainment <- ta
`
    : ""
}
${toJson("result")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 8. VPC data for Simulx ───────────────────────────────────────────────
  server.tool(
    "simulx_vpc_data",
    "Generate VPC (visual predictive check) prediction intervals for overlay with observed data.",
    {
      observed_data_path: z
        .string()
        .describe("Path to CSV with observed data (columns: id, time, dv)"),
      n_replications: z.number().int().positive().default(500),
      output_name: z.string().default("out1"),
      variable: z.string().default("Cc"),
      bins: z.number().int().positive().default(10).describe("Number of time bins"),
    },
    async ({ observed_data_path, n_replications, output_name, variable, bins }) => {
      const s = await pool.get("simulx");
      const out = await s.run(`
library(dplyr)
setNbReplicates(${n_replications})
runSimulx()
sim <- getSimulationResults()$${output_name}
obs <- read.csv("${observed_data_path}")

# Bin simulation
sim <- sim |>
  dplyr::mutate(bin = cut(time, breaks=${bins}, labels=FALSE))

vpc_sim <- sim |>
  dplyr::group_by(bin, replication) |>
  dplyr::summarise(med = median(${variable}), .groups="drop") |>
  dplyr::group_by(bin) |>
  dplyr::summarise(
    sim_p05 = quantile(med, 0.05),
    sim_p50 = quantile(med, 0.50),
    sim_p95 = quantile(med, 0.95),
    .groups="drop"
  )

# Bin observed
obs <- obs |>
  dplyr::mutate(bin = cut(time, breaks=${bins}, labels=FALSE))
vpc_obs <- obs |>
  dplyr::group_by(bin) |>
  dplyr::summarise(
    obs_p05 = quantile(dv, 0.05, na.rm=TRUE),
    obs_p50 = quantile(dv, 0.50, na.rm=TRUE),
    obs_p95 = quantile(dv, 0.95, na.rm=TRUE),
    .groups="drop"
  )

vpc <- dplyr::left_join(vpc_sim, vpc_obs, by="bin")
${toJson("vpc")}
`);
      return { content: [{ type: "text", text: out }] };
    }
  );
}
