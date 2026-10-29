import pytest
from pricing import apply_tax, line_total


def test_no_tax():
    assert apply_tax(1000, 0) == 1000


def test_whole_cent_tax():
    assert apply_tax(1000, 10) == 1100


def test_tax_rounds_half_up():
    # 999 * 1.075 = 1073.925 -> 1074 cents
    assert apply_tax(999, 7.5) == 1074


def test_negative_rejected():
    with pytest.raises(ValueError):
        apply_tax(-1, 5)


def test_line_total():
    assert line_total(250, 4, 10) == 1100
