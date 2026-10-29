"""A tiny shopping cart. Amounts are integer cents."""


class Cart:
    def __init__(self):
        self._items = {}  # name -> [unit_price_cents, qty]

    def add_item(self, name, price_cents, qty=1):
        if not isinstance(price_cents, int) or price_cents < 0:
            raise ValueError("price must be a non-negative integer number of cents")
        if not isinstance(qty, int) or qty <= 0:
            raise ValueError("qty must be a positive integer")
        if name in self._items:
            if self._items[name][0] != price_cents:
                raise ValueError("price mismatch for existing item")
            self._items[name][1] += qty
        else:
            self._items[name] = [price_cents, qty]

    def remove_item(self, name, qty=None):
        if name not in self._items:
            raise KeyError(name)
        if qty is None or qty >= self._items[name][1]:
            del self._items[name]
        else:
            self._items[name][1] -= qty

    def items(self):
        return {n: (p, q) for n, (p, q) in self._items.items()}

    def subtotal(self):
        return sum(p * q for p, q in self._items.values())

    def total(self):
        return self.subtotal()
