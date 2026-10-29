"""Launch trusted pytest in isolated Python mode with an explicit plugin path."""
import sys

sys.dont_write_bytecode = True
site, tools = sys.argv[1:3]
if site:
    sys.path.insert(0, site)
sys.path.insert(0, tools)
import pytest
raise SystemExit(pytest.main(sys.argv[3:]))
