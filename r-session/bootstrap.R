#!/usr/bin/env Rscript
# r-session/bootstrap.R
# Pre-flight check: verifies lixoftConnectors and required packages are installed.
# Run this manually before starting the MCP server:
#   Rscript r-session/bootstrap.R

required <- c("lixoftConnectors", "Rsmlx", "RsSimulx", "jsonlite", "dplyr")

cat("=== monolix-mcp R bootstrap ===\n\n")

results <- lapply(required, function(pkg) {
  installed <- requireNamespace(pkg, quietly = TRUE)
  status    <- if (installed) "OK" else "MISSING"
  cat(sprintf("  %-20s [%s]\n", pkg, status))
  list(package = pkg, installed = installed)
})

missing <- Filter(function(x) !x$installed, results)

cat("\n")

if (length(missing) > 0) {
  cat("Missing packages:\n")
  for (m in missing) {
    cat(sprintf("  - %s\n", m$package))
  }
  cat("\nInstall Rsmlx / RsSimulx from Lixoft:\n")
  cat("  install.packages('Rsmlx',   repos='https://lixoft.r-universe.dev')\n")
  cat("  install.packages('RsSimulx', repos='https://lixoft.r-universe.dev')\n")
  cat("\nInstall CRAN packages:\n")
  cat("  install.packages(c('jsonlite', 'dplyr'))\n")
  quit(status = 1)
} else {
  cat("All packages OK.\n\n")
}

# Test lixoftConnectors initialization
lixoft_home <- Sys.getenv("LIXOFT_HOME", unset = NA)

if (is.na(lixoft_home)) {
  cat("WARNING: LIXOFT_HOME environment variable not set.\n")
  cat("  Set it to your MonolixSuite installation path, e.g.:\n")
  cat("  export LIXOFT_HOME=/opt/MonolixSuite2024R1\n\n")
} else {
  cat(sprintf("LIXOFT_HOME = %s\n", lixoft_home))
  library(lixoftConnectors)
  tryCatch({
    initializeLixoftConnectors(software = "monolix", path = lixoft_home, force = TRUE)
    cat("lixoftConnectors initialized successfully for Monolix.\n")
    getLixoftConnectorsState()
  }, error = function(e) {
    cat(sprintf("ERROR: Could not initialize lixoftConnectors:\n  %s\n", conditionMessage(e)))
    quit(status = 1)
  })
}

cat("\n=== Bootstrap complete. Ready to start monolix-mcp. ===\n")
