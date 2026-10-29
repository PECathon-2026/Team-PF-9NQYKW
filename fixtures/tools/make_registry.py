import json
from tools_digest import suite_digest
REQ = {
 "cart": "Add a discount-code feature to the cart: support percentage codes and fixed-amount codes. Cart.apply_discount(('percent', n)) with 0<=n<=100 or Cart.apply_discount(('fixed', cents)) with cents>=0; total() applies the discount and must never go below 0; invalid codes raise ValueError; remove_discount() clears it and applying a new code replaces the old one. Existing behavior must keep working.",
 "stats": "Investigate the defect marked `# bug` in stats.py and fix it if confirmed.",
 "stock": "reserve(qty, available) rejects valid reservations; a test is failing. Fix the defect.",
 "notes": "Review the note store for security issues and fix any path-handling problems so notes cannot be read or written outside the store root (including absolute paths and symlinks), while normal notes keep working.",
 "titles": "clean up the titles",
}
reg = {"version": 1, "digest_algorithm": "sha256 over sorted '<sha256(file)>  <relpath>' lines (see tools_digest.py)", "scenarios": {}}
for s in REQ:
    e = {"repo_path": f"fixtures/repos/{s}", "request": REQ[s],
         "public_check": {"id": f"{s}.pytest", "argv": ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], "cwd": "."}}
    if s == "titles":
        e.update(private_suite=None, private_suite_digest=None, search_tool_disabled=True,
                 expected_outcome="escalate_for_clarification")
    else:
        p = f"fixtures/private/acceptance/{s}"
        e.update(private_suite={"path": p, "argv": ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", p], "candidate_env": "CANDIDATE_DIR"},
                 private_suite_digest=suite_digest(p), search_tool_disabled=False)
    e["expected_public_baseline"] = "fail" if s == "stock" else "pass"
    reg["scenarios"][s] = e
json.dump(reg, open("fixtures/registry.json", "w"), indent=2); open("fixtures/registry.json","a").write("\n")
