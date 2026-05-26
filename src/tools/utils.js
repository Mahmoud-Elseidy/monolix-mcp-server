/**
 * tools/utils.js
 * Utility MCP tools: session management, raw R execution,
 * mlxtran model scaffolding, and server status.
 */

import { z } from "zod";

export function registerUtilityTools(server, pool) {
  // ── 1. Server status ─────────────────────────────────────────────────────
  server.tool(
    "lixoft_status",
    "Return the status of all active R sessions (monolix/simulx/pkanalix), Lixoft installation, and server uptime.",
    {},
    async () => {
      const sessions = Object.entries(pool._sessions).map(([sw, s]) => ({
        software: sw,
        ready: s.ready,
        busy: s.busy,
        queue_length: s._queue.length,
      }));

      const status = {
        server: "monolix-mcp",
        version: "1.0.0",
        uptime_sec: Math.floor(process.uptime()),
        active_sessions: sessions,
        lixoft_home: pool.lixoftHome,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  // ── 2. Run arbitrary R code ───────────────────────────────────────────────
  server.tool(
    "lixoft_run_r",
    "Execute arbitrary R code in the specified Lixoft software session. Use for custom analyses not covered by other tools.",
    {
      code: z.string().describe("R code to execute"),
      software: z
        .enum(["monolix", "simulx", "pkanalix"])
        .default("monolix")
        .describe("Target R session"),
    },
    async ({ code, software }) => {
      const s = await pool.get(software);
      const out = await s.run(code);
      return { content: [{ type: "text", text: out || "(no output)" }] };
    }
  );

  // ── 3. Reset session ─────────────────────────────────────────────────────
  server.tool(
    "lixoft_reset_session",
    "Kill and restart the R session for the specified software. Clears all session state.",
    {
      software: z
        .enum(["monolix", "simulx", "pkanalix"])
        .describe("Session to reset"),
    },
    async ({ software }) => {
      if (pool._sessions[software]) {
        pool._sessions[software].stop();
        delete pool._sessions[software];
      }
      await pool.get(software); // re-initialize
      return {
        content: [{ type: "text", text: `Session '${software}' restarted.` }],
      };
    }
  );

  // ── 4. Generate mlxtran model scaffold ───────────────────────────────────
  server.tool(
    "mlxtran_scaffold",
    "Generate a complete mlxtran structural model file for a standard PK model. Returns the mlxtran text content.",
    {
      compartments: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(1)
        .describe("Number of PK compartments"),
      route: z
        .enum(["oral", "iv_bolus", "iv_infusion"])
        .default("oral"),
      pk_parameters: z
        .array(z.string())
        .default(["Cl", "V"])
        .describe("PK parameter names, e.g. ['Cl', 'V', 'ka', 'Q', 'V2']"),
      output_variable: z
        .string()
        .default("Cc")
        .describe("Output variable name (central compartment concentration)"),
      pd_model: z
        .enum(["none", "emax", "linear", "inh_emax"])
        .default("none")
        .describe("Optional PD model to append"),
    },
    async ({ compartments, route, pk_parameters, output_variable, pd_model }) => {
      // Build mlxtran model text programmatically
      const depot = route === "oral" ? "depot(type=1, target=Ac)" : "";
      const infusion = route === "iv_infusion" ? "depot(type=2, target=Ac)" : "";

      let odes = [];
      let params = [...pk_parameters];

      if (compartments === 1) {
        odes = [
          route === "oral" ? "ddt_Ad = -ka*Ad" : "",
          route === "oral"
            ? `ddt_Ac = ${route === "oral" ? "ka*Ad" : "Ri"} - (Cl/V)*Ac`
            : `ddt_Ac = Ri - (Cl/V)*Ac`,
        ].filter(Boolean);
      } else if (compartments === 2) {
        odes = [
          route === "oral" ? "ddt_Ad = -ka*Ad" : "",
          `ddt_Ac = ${route === "oral" ? "ka*Ad" : "Ri"} - (Cl/V)*Ac - (Q/V)*Ac + (Q/V2)*Ap`,
          "ddt_Ap = (Q/V)*Ac - (Q/V2)*Ap",
        ].filter(Boolean);
      } else {
        odes = [
          route === "oral" ? "ddt_Ad = -ka*Ad" : "",
          `ddt_Ac = ${route === "oral" ? "ka*Ad" : "Ri"} - (Cl/V)*Ac - (Q/V)*Ac + (Q/V2)*Ap - (Q2/V)*Ac + (Q2/V3)*Ap2`,
          "ddt_Ap  = (Q/V)*Ac  - (Q/V2)*Ap",
          "ddt_Ap2 = (Q2/V)*Ac - (Q2/V3)*Ap2",
        ].filter(Boolean);
      }

      let pdSection = "";
      if (pd_model === "emax") {
        pdSection = `
[LONGITUDINAL]
input = {Emax, EC50, E0}
EQUATION:
  E = E0 + Emax*${output_variable}/(EC50 + ${output_variable})
OUTPUT:
  output = E`;
        params = [...params, "Emax", "EC50", "E0"];
      } else if (pd_model === "inh_emax") {
        pdSection = `
[LONGITUDINAL]
input = {Imax, IC50, Rin, kout}
EQUATION:
  ddt_R = Rin*(1 - Imax*${output_variable}/(IC50+${output_variable})) - kout*R
OUTPUT:
  output = R`;
        params = [...params, "Imax", "IC50", "Rin", "kout"];
      }

      const mlxtran = `; mlxtran model — ${compartments}cpt ${route} PK
; Generated by monolix-mcp

[LONGITUDINAL]
input = {${params.join(", ")}}

PK:
${depot || infusion ? (depot || infusion) + "\n" : ""}${odes.map((l) => "  " + l).join("\n")}

EQUATION:
  ${output_variable} = Ac / V

OUTPUT:
  output = ${output_variable}
${pdSection}
`.trim();

      return { content: [{ type: "text", text: mlxtran }] };
    }
  );

  // ── 5. List available Lixoft library models ───────────────────────────────
  server.tool(
    "lixoft_list_library_models",
    "List built-in models from the Lixoft model library for a given library type.",
    {
      library: z
        .enum(["pk", "pd", "pkpd", "tmdd", "tte", "count", "categorical"])
        .default("pk")
        .describe("Library to browse"),
      filter: z
        .string()
        .optional()
        .describe("Optional substring filter, e.g. 'oral' or '2cpt'"),
    },
    async ({ library, filter }) => {
      const s = await pool.get("monolix");
      const filterCode = filter
        ? `models <- models[grepl("${filter}", models, ignore.case=TRUE)]`
        : "";
      const out = await s.run(`
models <- getLibraryModelName(library="${library}")
${filterCode}
cat(jsonlite::toJSON(models, auto_unbox=TRUE))
`);
      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── 6. Data import & header mapping validation ────────────────────────────
  server.tool(
    "monolix_validate_data",
    "Load a data CSV and validate NONMEM/Monolix header types. Returns a summary of header assignments and any issues.",
    {
      data_path: z.string().describe("Path to CSV data file"),
      header_types: z
        .record(z.string())
        .optional()
        .describe("Column-to-headerType mapping, e.g. {ID:'id', TIME:'time', DV:'observation'}"),
    },
    async ({ data_path, header_types }) => {
      const s = await pool.get("monolix");
      const headerCode = header_types
        ? `setData(dataFile="${data_path}", headerTypes=list(${
            Object.entries(header_types)
              .map(([col, type]) => `"${col}"="${type}"`)
              .join(", ")
          }))`
        : `setData(dataFile="${data_path}")`;
      const out = await s.run(`
${headerCode}
d <- getData()
summary_info <- list(
  n_rows    = nrow(d$data),
  n_subjects= length(unique(d$data[[which(d$headerTypes=="id")]])),
  headers   = setNames(as.list(d$headerTypes), names(d$data)),
  observations = table(d$data[[which(d$headerTypes=="obsid")]])
)
cat(jsonlite::toJSON(summary_info, auto_unbox=TRUE))
`);
      return { content: [{ type: "text", text: out }] };
    }
  );
}
