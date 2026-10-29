"""Candidate-only interpreter. Never mount private suites or reports here."""
import contextlib
import importlib
import json
import os
import pathlib
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
if len(sys.argv) > 2 and sys.argv[2]:
    # Explicitly add the trusted interpreter's user-site for development
    # installations where pytest is not installed system-wide.
    sys.path.append(sys.argv[2])
objects = {}
next_id = 0
protocol = os.fdopen(os.dup(1), "w", buffering=1)


def decode(value):
    if isinstance(value, list):
        return [decode(x) for x in value]
    if isinstance(value, dict):
        kind = value.get("__devpilot__")
        if kind == "ref":
            return objects[value["id"]]
        if kind == "path":
            return pathlib.Path(value["value"])
        if kind == "tuple":
            return tuple(decode(x) for x in value["items"])
        if kind == "iterator":
            return iter(decode(value["items"]))
        return {k: decode(v) for k, v in value.items()}
    return value


def encode(value):
    global next_id
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [encode(x) for x in value]
    if isinstance(value, tuple):
        return {"__devpilot__": "tuple", "items": [encode(x) for x in value]}
    if isinstance(value, dict):
        return {str(k): encode(v) for k, v in value.items()}
    next_id += 1
    objects[next_id] = value
    return {"__devpilot__": "ref", "id": next_id}


for line in sys.stdin:
    try:
        command = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            if command["op"] == "call":
                target = getattr(importlib.import_module(command["module"]), command["name"])
            elif command["op"] == "method":
                target = getattr(objects[command["id"]], command["name"])
            else:
                raise ValueError("invalid operation")
            value = target(*decode(command["args"]), **decode(command["kwargs"]))
        result = {"ok": True, "value": encode(value)}
    except BaseException as exc:
        result = {"ok": False, "error": type(exc).__name__}
    try:
        protocol.write(json.dumps(result, allow_nan=False) + "\n")
    except (BrokenPipeError, ValueError, TypeError):
        break
