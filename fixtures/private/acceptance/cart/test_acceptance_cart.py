"""Private acceptance: discount codes. Contract (stated in registry request):
Cart.apply_discount(("percent", n)) with 0<=n<=100, or ("fixed", cents>=0);
total() applies it, never below 0; invalid codes raise ValueError;
remove_discount() clears it; applying a new code replaces the old one."""
import pytest
from cart import Cart


def _cart(amount=1000):
    c = Cart()
    c.add_item("thing", amount)
    return c


def test_ac1_percent_discount():
    c = _cart(1000); c.apply_discount(("percent", 10))
    assert c.total() == 900


def test_ac2_fixed_discount():
    c = _cart(1000); c.apply_discount(("fixed", 250))
    assert c.total() == 750


def test_ac3_fixed_cannot_go_below_zero():
    c = _cart(300); c.apply_discount(("fixed", 500))
    assert c.total() == 0


def test_ac3_percent_100_is_zero():
    c = _cart(999); c.apply_discount(("percent", 100))
    assert c.total() == 0


@pytest.mark.parametrize("code", [("percent", -5), ("percent", 101), ("fixed", -1), ("bogus", 5)])
def test_ac4_invalid_codes_rejected(code):
    with pytest.raises(ValueError):
        _cart().apply_discount(code)


def test_ac5_remove_and_replace():
    c = _cart(1000)
    c.apply_discount(("percent", 50)); c.apply_discount(("fixed", 100))
    assert c.total() == 900
    c.remove_discount()
    assert c.total() == 1000


def test_ac6_subtotal_unchanged_and_existing_behavior():
    c = _cart(1000); c.add_item("thing", 1000)
    c.apply_discount(("percent", 25))
    assert c.subtotal() == 2000 and c.total() == 1500
    assert Cart().total() == 0
