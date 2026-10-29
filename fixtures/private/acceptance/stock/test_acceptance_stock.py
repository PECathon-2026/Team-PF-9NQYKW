import pytest
from stock import reserve, Inventory


@pytest.mark.parametrize("qty,avail,left", [(1, 1, 0), (3, 3, 0), (1, 10, 9), (10, 10, 0)])
def test_ac1_boundary_success(qty, avail, left):
    assert reserve(qty, avail) == left


@pytest.mark.parametrize("qty,avail", [(4, 3), (1, 0), (2, 1)])
def test_ac2_over_reserve_rejected(qty, avail):
    with pytest.raises(ValueError):
        reserve(qty, avail)


@pytest.mark.parametrize("qty", [0, -1])
def test_ac3_non_positive_rejected(qty):
    with pytest.raises(ValueError):
        reserve(qty, 5)


def test_ac4_inventory_drain_and_failure_keeps_stock():
    inv = Inventory(); inv.restock("A", 3)
    assert inv.reserve("A", 3) == 0
    with pytest.raises(ValueError):
        inv.reserve("A", 1)
    assert inv.available("A") == 0
