import pytest
from cart import Cart


def test_empty_cart_totals_zero():
    assert Cart().total() == 0


def test_add_and_total():
    c = Cart()
    c.add_item("apple", 150, 2)
    c.add_item("pear", 200)
    assert c.subtotal() == 500
    assert c.total() == 500


def test_add_same_item_accumulates():
    c = Cart()
    c.add_item("apple", 150)
    c.add_item("apple", 150, 2)
    assert c.items()["apple"] == (150, 3)


def test_remove_item():
    c = Cart()
    c.add_item("apple", 150, 3)
    c.remove_item("apple", 1)
    assert c.total() == 300
    c.remove_item("apple")
    assert c.total() == 0


def test_invalid_inputs():
    c = Cart()
    with pytest.raises(ValueError):
        c.add_item("x", -1)
    with pytest.raises(ValueError):
        c.add_item("x", 100, 0)
    with pytest.raises(KeyError):
        c.remove_item("missing")
