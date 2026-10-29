"""Inventory reservation helpers."""


def reserve(qty, available):
    """Reserve `qty` units out of `available`. Returns remaining stock.

    Raises ValueError if qty is not positive or exceeds available stock.
    """
    if qty <= 0:
        raise ValueError("qty must be positive")
    if qty >= available:
        raise ValueError("insufficient stock")
    return available - qty


class Inventory:
    def __init__(self):
        self._stock = {}

    def restock(self, sku, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._stock[sku] = self._stock.get(sku, 0) + qty

    def available(self, sku):
        return self._stock.get(sku, 0)

    def reserve(self, sku, qty):
        self._stock[sku] = reserve(qty, self.available(sku))
        return self._stock[sku]
