import math
import pytest
from stats import mean, median


def test_ac1_non_integer_mean():
    assert mean([1, 2]) == pytest.approx(1.5)
    assert mean([1, 2, 2]) == pytest.approx(5 / 3)


def test_ac2_negative_values():
    assert mean([-1, -2]) == pytest.approx(-1.5)


def test_ac3_float_inputs():
    assert mean([0.1, 0.2, 0.3]) == pytest.approx(0.2)


def test_ac4_returns_float_like():
    assert isinstance(mean([1, 2]), float)


def test_ac5_existing_behavior():
    assert mean([2, 4, 6]) == 4
    with pytest.raises(ValueError):
        mean([])
    assert median([1, 2, 3, 4]) == 2.5
    assert mean(iter([1, 2])) == pytest.approx(1.5)
