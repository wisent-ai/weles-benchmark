#!/usr/bin/env bash
set -euo pipefail

suite="${BENCHMARK_SUITE:-suites/web-agent-v1.json}"
fixture_origin="${FIXTURE_ORIGIN:-http://127.0.0.1:8787}"
results_dir="${RESULTS_DIR:-results}"
mkdir -p "$results_dir"

npm ci --ignore-scripts
npm run build
python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -r requirements-browser-use.txt
.venv/bin/python -m playwright install chromium

node dist/cli.js fixture --host 127.0.0.1 --port 8787 >"$results_dir/fixture.log" 2>&1 &
fixture_pid=$!
cleanup() {
  kill "$fixture_pid" 2>/dev/null || true
}
trap cleanup EXIT
sleep 2

export BRAMA_BASE_URL="${BRAMA_BASE_URL:-http://127.0.0.1:8080/v1}"
export BRAMA_MODEL="${BRAMA_MODEL:-gpt-5.4-mini}"
export BROWSER_USE_PYTHON="${BROWSER_USE_PYTHON:-.venv/bin/python}"
export WELES_API_BASE="${WELES_API_BASE:-http://127.0.0.1:8788}"

run_adapter() {
  local adapter="$1"
  shift
  set +e
  node dist/cli.js run \
    --suite "$suite" \
    --fixture-origin "$fixture_origin" \
    --adapter "$adapter" \
    --out "$results_dir/$adapter.json" \
    "$@"
  local status=$?
  set -e
  printf '%s\t%s\n' "$adapter" "$status" >>"$results_dir/exit-status.tsv"
}

: >"$results_dir/exit-status.tsv"
run_adapter weles
run_adapter browser-use
run_adapter stagehand

if [[ -n "${SKYVERN_API_KEY:-}" || -n "${SKYVERN_BASE_URL:-}" ]]; then
  run_adapter skyvern
fi

for candidate in browser-use stagehand skyvern; do
  if [[ -f "$results_dir/weles.json" && -f "$results_dir/$candidate.json" ]]; then
    node dist/cli.js compare \
      --baseline "$results_dir/weles.json" \
      --candidate "$results_dir/$candidate.json" \
      --out "$results_dir/weles-vs-$candidate.md"
  fi
done

node -e '
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
const rows = [];
for (const name of ["weles", "browser-use", "stagehand", "skyvern"]) {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) continue;
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  rows.push({
    adapter: name,
    suiteSha256: run.suite?.sha256 ?? run.suiteSha256,
    samples: run.summary?.samples,
    successRate: run.summary?.successRate,
    p50DurationMs: run.summary?.durationMs?.p50,
    p95DurationMs: run.summary?.durationMs?.p95,
    qualification: run.qualification?.passed,
    failures: run.summary?.failures,
  });
}
fs.writeFileSync(path.join(dir, "comparison-summary.json"), `${JSON.stringify({ schema: "weles.benchmark.comparison-summary.v1", rows }, null, 2)}\n`);
' "$results_dir"

tar -czf weles-benchmark-results.tgz "$results_dir"
stado artifact upload weles-benchmark-results.tgz
