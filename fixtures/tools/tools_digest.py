"""Suite digest: sha256 over sorted lines "<sha256(file)>  <relpath>\n" for every file in the suite dir
(excluding __pycache__/.pytest_cache)."""
import hashlib, os, sys
def suite_digest(d):
    lines = []
    for base, dirs, files in os.walk(d):
        dirs[:] = sorted(x for x in dirs if x not in ("__pycache__", ".pytest_cache"))
        for f in files:
            p = os.path.join(base, f)
            lines.append(f"{hashlib.sha256(open(p,'rb').read()).hexdigest()}  {os.path.relpath(p, d)}\n")
    return "sha256:" + hashlib.sha256("".join(sorted(lines)).encode()).hexdigest()
if __name__ == "__main__":
    print(suite_digest(sys.argv[1]))
