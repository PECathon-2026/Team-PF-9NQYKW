"""Price helpers. Amounts are integer cents."""


def apply_tax(cents, rate_percent):
    """Return `cents` with `rate_percent` tax added, rounded half up to a cent.

    Raises ValueError if `cents` or `rate_percent` is negative.
    """
    if cents < 0 or rate_percent < 0:
        raise ValueError("amounts must be non-negative")
    return int(cents * (100 + rate_percent) / 100)


def line_total(unit_cents, qty, rate_percent):
    """Total for `qty` units including tax, taxed once on the line subtotal."""
    if qty < 0:
        raise ValueError("qty must be non-negative")
    return apply_tax(unit_cents * qty, rate_percent)
