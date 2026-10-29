import os, sys
import pytest

_dir = os.environ.get("CANDIDATE_DIR")
if not _dir or not os.path.isdir(_dir):
    pytest.exit("CANDIDATE_DIR must point to the candidate repository root", returncode=4)
sys.path.insert(0, os.path.abspath(_dir))
