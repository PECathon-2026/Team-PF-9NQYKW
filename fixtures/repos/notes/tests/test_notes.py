from notes import NoteStore


def test_write_read(tmp_path):
    s = NoteStore(tmp_path / "store")
    s.write("todo.txt", "buy milk")
    assert s.read("todo.txt") == "buy milk"


def test_overwrite_and_list(tmp_path):
    s = NoteStore(tmp_path / "store")
    s.write("b", "1"); s.write("a", "2"); s.write("a", "3")
    assert s.read("a") == "3"
    assert s.list() == ["a", "b"]
