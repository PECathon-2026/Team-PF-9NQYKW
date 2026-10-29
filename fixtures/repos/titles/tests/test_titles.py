from titles import make_title, slugify


def test_make_title_strips():
    assert make_title("  Hello World  ") == "Hello World"


def test_slugify():
    assert slugify("Hello, World!") == "hello-world"
    assert slugify("  a  b ") == "a-b"
