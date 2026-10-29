import pytest
from stock import reserve, Inventory


def test_reserve_partial():
    assert reserve(2, 5) == 3


def test_reserve_too_many():
    with pytest.raises(ValueError):
        reserve(6, 5)


def test_reserve_exactly_all_available():
    assert reserve(3, 3) == 0


def test_inventory_flow():
    inv = Inventory()
    inv.restock("A", 5)
    assert inv.reserve("A", 2) == 3
    assert inv.available("A") == 3
