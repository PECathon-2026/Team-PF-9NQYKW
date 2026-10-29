"""Start trusted pytest before adding the candidate to the import path."""
import os
import sys

sys.dont_write_bytecode = True
site, candidate = sys.argv[1:3]
if site:
    sys.path.insert(0, site)

import pytest

sys.path.insert(0, candidate)
# GitHub missions: src/ layout and third-party dependencies installed during
# the (network-enabled) install step. Dependencies go after the candidate and
# after trusted pytest has been imported, so neither can be shadowed by them.
if os.environ.get("DEVPILOT_SRC_LAYOUT") == "1":
    sys.path.insert(0, os.path.join(candidate, "src"))
if os.environ.get("DEVPILOT_DEPS"):
    sys.path.append(os.environ["DEVPILOT_DEPS"])
raise SystemExit(pytest.main(sys.argv[3:]))
