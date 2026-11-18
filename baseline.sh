#!/usr/bin/env bash
# Reproduces the published baseline. Each role runs on its own model, so each gets its own rate limit:
#   attackers  ATTACKER_MODEL   the agent  TARGET_MODEL   judge + policy reader  JUDGE_MODEL
# Usage: bash baseline.sh [out-dir]      ONLY=airline,northwind bash baseline.sh  reruns just those
set -u
OUT=${1:-baseline/$(date +%Y-%m-%d)}
export ATTACKER_MODEL=${ATTACKER_MODEL:-qwen/qwen3.8-27b}
export TARGET_MODEL=${TARGET_MODEL:-openai/gpt-oss-120b}
export JUDGE_MODEL=${JUDGE_MODEL:-openai/gpt-oss-20b}
TEAM=social-engineer,policy-liar,sympathy-lever,scope-creeper,false-urgency
run() { name=$1; shift; echo "=== $name $(date +%H:%M:%S)"; node --env-file=.env cli.js "$@" --attackers $TEAM --trials 3 --out "$OUT/$name"; }
ONLY=${ONLY:-retail,retail-no-recon,airline,northwind,northwind-no-recon}
want() { case ",$ONLY," in *",$1,"*) return 0;; *) return 1;; esac; }
want retail             && run retail             --target taubench-retail
want retail-no-recon    && run retail-no-recon    --target taubench-retail --no-recon
want airline            && run airline            --target taubench-airline
want northwind          && run northwind          --target northwind
want northwind-no-recon && run northwind-no-recon --target northwind --no-recon
echo "=== done $(date +%H:%M:%S)"
