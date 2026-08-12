# Security

Report vulnerabilities through a private GitHub Security Advisory for
`wisent-ai/weles-benchmark`.

Do not attach Weles, Brama, or Skyvern credentials; scenario inputs; raw adapter
output; recordings; screenshots; DOM captures; or customer origins. Include only
the benchmark version, typed failure code, and a minimal synthetic reproduction.

The command adapter executes an operator-selected local binary. Treat that binary
as code execution, use an absolute path, and expose only explicitly required
environment variables with `--command-env`.

Run direct browser adapters only through Stado on a dedicated host. Inject
credentials as scoped workload environment variables; never place them in job
commands, repository files, result artifacts, or process arguments.
