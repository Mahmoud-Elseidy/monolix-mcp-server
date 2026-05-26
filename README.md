# monolix-mcp

**A local MCP (Model Context Protocol) server** that exposes Lixoft MonolixSuite
(Monolix, Simulx, PKanalix) to Claude via a persistent R session using `lixoftConnectors`.

---

## Architecture

```
Claude Desktop / Claude.ai
        ↕  JSON-RPC (stdio)
monolix-mcp  (Node.js, this server)
        ↕  persistent child_process (readline IPC)
R session  →  lixoftConnectors
        ↕
Monolix / Simulx / PKanalix  (local install)
```

One background R process per software target. Sessions are **lazy-initialized**
on first use and **reused** across all tool calls — no per-call startup overhead.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| R | ≥ 4.3 |
| MonolixSuite | 2023R1 or 2024R1 |
| lixoftConnectors | bundled with MonolixSuite |
| Rsmlx | ≥ 4.1 (Lixoft R-universe) |
| RsSimulx | ≥ 3.0 (Lixoft R-universe) |
| jsonlite, dplyr | CRAN |

### Install R packages

```r
# Lixoft packages
install.packages(c("Rsmlx", "RsSimulx"),
                 repos = "https://lixoft.r-universe.dev")

# lixoftConnectors (installed with MonolixSuite, but may need path fix)
# See: https://lixoft.com/faq/lixoftconnectors-installation/

# CRAN
install.packages(c("jsonlite", "dplyr"))
```

---

## Setup

```bash
# 1. Clone / copy this folder
cd monolix-mcp

# 2. Install Node dependencies
npm install

# 3. Verify R packages and Monolix installation
export LIXOFT_HOME=/opt/MonolixSuite2024R1    # Linux
# or: set LIXOFT_HOME=C:\ProgramData\Lixoft\MonolixSuite2024R1  (Windows)
Rscript r-session/bootstrap.R

# 4. Start the MCP server (for manual testing)
node src/index.js
```

---

## Claude Desktop Configuration

Edit `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "monolix": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/monolix-mcp/src/index.js"],
      "env": {
        "LIXOFT_HOME": "/opt/MonolixSuite2024R1"
      }
    }
  }
}
```

**Windows example:**

```json
{
  "mcpServers": {
    "monolix": {
      "command": "node",
      "args": ["C:\\Users\\mahmoud\\monolix-mcp\\src\\index.js"],
      "env": {
        "LIXOFT_HOME": "C:\\ProgramData\\Lixoft\\MonolixSuite2024R1"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

---

## Available Tools

### Monolix (SAEM estimation)

| Tool | Description |
|---|---|
| `monolix_load_project` | Load `.mlxtran` project |
| `monolix_get_project_info` | Dataset & model metadata |
| `monolix_set_structural_model` | Change PK/PD model |
| `monolix_set_covariate_model` | Define covariate–parameter links |
| `monolix_set_variability_model` | Set IIV (random effects) structure |
| `monolix_set_initial_estimates` | Set SAEM starting values |
| `monolix_run` | Execute estimation tasks |
| `monolix_get_estimates` | Population parameters + SE/RSE |
| `monolix_get_individual_estimates` | EBE per subject |
| `monolix_get_llx` | AIC, BIC, BICc |
| `monolix_get_convergence` | SAEM iteration history |
| `monolix_get_residuals` | IWRES, NPDE |
| `monolix_get_obs_pred` | Observed vs predicted |
| `monolix_get_random_effects` | Eta per subject |
| `monolix_save_project` | Save project |

### Simulx (simulation)

| Tool | Description |
|---|---|
| `simulx_load_project` | Load `.smlx` or init from Monolix |
| `simulx_define_population` | Virtual population with covariate distributions |
| `simulx_define_regimen` | Dosing regimen (oral/IV bolus/infusion) |
| `simulx_define_output` | PK/PD output grid |
| `simulx_run` | Execute simulation |
| `simulx_get_results` | Individual or percentile profiles |
| `simulx_get_exposure` | AUC, Cmax, Ctrough, target attainment |
| `simulx_vpc_data` | VPC prediction intervals |

### PKanalix (NCA)

| Tool | Description |
|---|---|
| `pkanalix_load_project` | Load `.pkax` project |
| `pkanalix_run_nca` | Execute NCA |
| `pkanalix_get_results` | Per-subject NCA parameters |
| `pkanalix_get_summary` | Geometric mean, CV%, 90% CI |
| `pkanalix_dose_normalized` | Dose-normalized AUC/Cmax |
| `pkanalix_export_csv` | Export results to CSV |

### Rsmlx (automated model building)

| Tool | Description |
|---|---|
| `rsmlx_buildmlx` | Stepwise covariate + IIV building |
| `rsmlx_confintmlx` | Profile likelihood CIs |
| `rsmlx_llp` | Log-likelihood profiling (identifiability) |
| `rsmlx_automatic_model` | Full automated model selection |
| `rsmlx_covariate_summary` | Stepwise covariate selection log |

### Utilities

| Tool | Description |
|---|---|
| `lixoft_status` | Session status and uptime |
| `lixoft_run_r` | Execute arbitrary R code in any session |
| `lixoft_reset_session` | Restart a crashed R session |
| `mlxtran_scaffold` | Generate mlxtran model file (1–3 cpt, oral/IV) |
| `lixoft_list_library_models` | Browse Lixoft built-in model library |
| `monolix_validate_data` | Validate data CSV and header mapping |

---

## Example Claude Prompts (after connecting MCP)

```
Load my tacrolimus project at /projects/tac_peds.mlxtran and run estimation.

Show me the population PK estimates with RSE for the current model.

Build the covariate model automatically using COSSAC with p < 0.05.

Simulate 1000 virtual pediatric patients using the estimated model,
dosing 0.1 mg/kg Q12h, and compute tacrolimus trough target attainment
(target 5–15 ng/mL) at steady state.

Generate a 1-compartment oral absorption mlxtran model file with Cl, V, ka.
```

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `R session init timeout` | Check `LIXOFT_HOME` path; run `bootstrap.R` |
| `lixoftConnectors not found` | Install from the suite: `install.packages("<LIXOFT_HOME>/connectors/lixoftConnectors.tar.gz", repos=NULL, type="source")` (deps: `RJSONIO`, `ggplot2`, `gridExtra`, `gtable`) |
| `spawn EFTYPE` / "This app can't run on your PC" | The R install's top-level `bin\Rscript.exe` is a 0-byte launcher stub. The server auto-skips it and uses `bin\x64\Rterm.exe`. To pin manually, set `RSCRIPT_PATH` (or `R_BINARY`) to a working R/Rterm executable. Reinstalling R restores the stub. |
| `Rscript not found` (R not on PATH) | The server auto-detects R under `C:\Program Files\R`. Override with `RSCRIPT_PATH` / `R_BINARY` if installed elsewhere. |
| Wrong MonolixSuite version chosen | The server picks the newest `MonolixSuite*` under `C:\Program Files\Lixoft` and `C:\ProgramData\Lixoft`. Set `LIXOFT_HOME` to force a specific install. |
| `SAEM timeout` | Increase `TIMEOUT_MS` in `r-session.js` (default: 10 min) |
| Windows path errors | Use forward slashes in R paths within `env` |
| Session crash | Use `lixoft_reset_session` tool to restart |

### Environment variables

| Variable | Purpose |
|---|---|
| `LIXOFT_HOME` | MonolixSuite install dir. Omit to auto-detect the newest install. |
| `RSCRIPT_PATH` / `R_BINARY` | Path to the R interpreter (Rterm/R, or an Rscript whose sibling Rterm is used). Omit to auto-detect. |

---

## License

MIT — Mahmoud Ibrahim Mostafa, Helwan University / BUE
