import pytest
from stats import total, mean, median


def test_total():
    assert total([1, 2, 3]) == 6


def test_mean_of_evenly_divisible_ints():
    assert mean([2, 4, 6]) == 4
    assert mean([5]) == 5


def test_mean_empty_raises():
    with pytest.raises(ValueError):
        mean([])


def test_median():
    assert median([3, 1, 2]) == 2
    assert median([1, 2, 3, 4]) == 2.5
