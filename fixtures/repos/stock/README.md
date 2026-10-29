# stock

Inventory reservation. `reserve(qty, available)` returns remaining stock and
raises `ValueError` when `qty` is not positive or exceeds `available`.

Run tests: `pytest -q`  (one test currently fails)
