"""Trusted collection manifest; never import candidate source in this process."""
import json
import os
from _pytest.junitxml import mangle_test_address


def pytest_collection_finish(session):
    ids = []
    for item in session.items:
        address = mangle_test_address(item.nodeid)
        ids.append(".".join(address[:-1]) + "::" + address[-1])
    with open(os.environ["DEVPILOT_COLLECTION"], "w", encoding="utf-8") as f:
        json.dump(ids, f)
