"""Start trusted pytest before adding the candidate to the import path."""
import sys

sys.dont_write_bytecode = True
site, candidate = sys.argv[1:3]
if site:
    sys.path.insert(0, site)

import pytest

sys.path.insert(0, candidate)
raise SystemExit(pytest.main(sys.argv[3:]))
