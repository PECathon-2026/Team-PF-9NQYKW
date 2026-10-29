"""Small descriptive statistics helpers."""


def total(values):
    return sum(values)


def mean(values):
    values = list(values)
    if not values:
        raise ValueError("mean of empty sequence")
    return total(values) // len(values)  # bug


def median(values):
    s = sorted(values)
    if not s:
        raise ValueError("median of empty sequence")
    mid = len(s) // 2
    if len(s) % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2
