import pytest
from pricing import apply_tax, line_total


@pytest.mark.parametrize(
    "cents,rate,expected",
    [(999, 7.5, 1074), (1, 50, 2), (3, 50, 5), (10, 5, 11), (105, 10, 116), (1000, 0, 1000), (0, 20, 0)],
)
def test_ac1_rounds_half_up(cents, rate, expected):
    assert apply_tax(cents, rate) == expected


@pytest.mark.parametrize("cents,rate,expected", [(1, 49, 1), (10, 4, 10), (999, 7.4, 1073)])
def test_ac2_rounds_down_below_half(cents, rate, expected):
    assert apply_tax(cents, rate) == expected


@pytest.mark.parametrize("cents,rate", [(-1, 5), (5, -1)])
def test_ac3_negative_rejected(cents, rate):
    with pytest.raises(ValueError):
        apply_tax(cents, rate)


def test_ac4_line_total_taxes_subtotal_once():
    assert line_total(333, 3, 7.5) == 1074
    assert line_total(1, 3, 50) == 5
    with pytest.raises(ValueError):
        line_total(100, -1, 5)


def test_ac5_returns_int():
    assert isinstance(apply_tax(999, 7.5), int)
