"""Trusted client used by private tests; candidate objects live in a worker."""
import json
import os
import pathlib
import socket
import types

_socket = None
_reader = None


def _encode(value):
    if isinstance(value, RemoteObject):
        return {"__devpilot__": "ref", "id": value._id}
    if isinstance(value, pathlib.Path):
        return {"__devpilot__": "path", "value": str(value)}
    if isinstance(value, tuple):
        return {"__devpilot__": "tuple", "items": [_encode(x) for x in value]}
    if isinstance(value, list):
        return [_encode(x) for x in value]
    if isinstance(value, dict):
        return {str(k): _encode(v) for k, v in value.items()}
    if isinstance(value, types.GeneratorType) or isinstance(value, type(iter([]))):
        return {"__devpilot__": "iterator", "items": [_encode(x) for x in value]}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError("unsupported candidate argument")


def _decode(value):
    if isinstance(value, list):
        return [_decode(x) for x in value]
    if isinstance(value, dict):
        kind = value.get("__devpilot__")
        if kind == "ref":
            return RemoteObject(value["id"])
        if kind == "tuple":
            return tuple(_decode(x) for x in value["items"])
        return {k: _decode(v) for k, v in value.items()}
    return value


def _call(payload):
    global _socket, _reader
    if _socket is None:
        _socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        _socket.connect(os.environ["DEVPILOT_RPC"])
        _reader = _socket.makefile("rb")
    _socket.sendall((json.dumps(payload, allow_nan=False) + "\n").encode())
    line = _reader.readline(1048577)
    if not line or len(line) > 1048576:
        raise RuntimeError("candidate worker unavailable")
    try:
        result = json.loads(line)
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError("invalid candidate response") from exc
    if not result.get("ok"):
        errors = {"ValueError": ValueError, "PermissionError": PermissionError, "KeyError": KeyError, "TypeError": TypeError, "FileNotFoundError": FileNotFoundError, "OSError": OSError, "AttributeError": AttributeError}
        raise errors.get(result.get("error"), RuntimeError)("candidate raised an exception")
    return _decode(result["value"])


class RemoteObject:
    def __init__(self, ident):
        self._id = ident

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        def invoke(*args, **kwargs):
            return _call({"op": "method", "id": self._id, "name": name, "args": _encode(args), "kwargs": _encode(kwargs)})
        return invoke


def resolve(module, name):
    if name.startswith("__"):
        raise AttributeError(name)
    def invoke(*args, **kwargs):
        return _call({"op": "call", "module": module, "name": name, "args": _encode(args), "kwargs": _encode(kwargs)})
    return invoke
