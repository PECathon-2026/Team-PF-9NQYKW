#!/usr/bin/env bash
# Verifies public tests on seeds and private suites on seed (expect fail) vs reference (expect pass).
cd "$(dirname "$0")"; PY="$PWD/.venv/bin/python"; export PYTHONDONTWRITEBYTECODE=1
T=$(mktemp -d); rc=0
chk(){ [ "$2" = "$3" ] && echo "OK   $1 (exit $2)" || { echo "FAIL $1 (exit $2, want $3)"; rc=1; }; }
want(){ [ "$1" = pass ] && echo 0 || echo 1; }
for s in cart stats stock notes titles cheat; do
  cp -r fixtures/repos/$s $T/seed_$s
  (cd $T/seed_$s && $PY -m pytest -q -p no:cacheprovider tests >/dev/null); e=$?
  case $s in stock|cheat) w=1 ;; *) w=0 ;; esac; chk "$s public@seed" $e $w
  [ $s = titles ] && continue
  CANDIDATE_DIR=$T/seed_$s $PY -m pytest -q -p no:cacheprovider --rootdir=$T fixtures/private/acceptance/$s >$T/$s.seed.log; chk "$s private@seed" $? 1
  tail -1 $T/$s.seed.log
  cp -r fixtures/repos/$s $T/ref_$s && cp _reference/$s/* $T/ref_$s/
  (cd $T/ref_$s && $PY -m pytest -q -p no:cacheprovider tests >/dev/null); chk "$s public@reference" $? 0
  CANDIDATE_DIR=$T/ref_$s $PY -m pytest -q -p no:cacheprovider --rootdir=$T fixtures/private/acceptance/$s >$T/$s.ref.log; chk "$s private@reference" $? 0
  tail -1 $T/$s.ref.log
done
# guard: missing CANDIDATE_DIR must not silently pass
env -u CANDIDATE_DIR $PY -m pytest -q -p no:cacheprovider fixtures/private/acceptance/cart >/dev/null 2>&1; e=$?; [ $e -ne 0 ] && echo "OK   unset CANDIDATE_DIR fails closed (exit $e)" || { echo "FAIL unset CANDIDATE_DIR"; rc=1; }
# guard: no network/secret-ish imports in fixtures
grep -rEn "import (socket|urllib|requests|http|subprocess)|API_KEY|SECRET_|password" fixtures/repos && { echo "FAIL forbidden pattern"; rc=1; } || echo "OK   no network/secret patterns in fixtures"
# digest check
$PY - <<'P' || rc=1
import json; from tools_digest import suite_digest
r=json.load(open("fixtures/registry.json"))["scenarios"]
bad=[s for s,e in r.items() if e["private_suite"] and suite_digest(e["private_suite"]["path"])!=e["private_suite_digest"]]
print("FAIL digests "+str(bad) if bad else "OK   registry digests match"); raise SystemExit(1 if bad else 0)
P
rm -rf $T; exit $rc
