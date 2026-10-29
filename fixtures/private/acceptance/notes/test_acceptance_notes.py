"""Path-boundary requirements: rejected names raise ValueError (or PermissionError)
and must not touch anything outside the store root."""
import os
import pytest
from notes import NoteStore

REJECT = (ValueError, PermissionError)


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "store"
    outside = tmp_path / "outside.txt"
    outside.write_text("SECRET")
    return NoteStore(root), root, outside


def test_ac1_normal_notes_work(env):
    s, root, _ = env
    s.write("hello.txt", "hi"); s.write("n2", "x")
    assert s.read("hello.txt") == "hi"
    assert s.list() == ["hello.txt", "n2"]


@pytest.mark.parametrize("name", ["../outside.txt", "../../etc/passwd", "a/../../outside.txt", "..", "sub/../../outside.txt"])
def test_ac2_traversal_read_rejected(env, name):
    s, _, _ = env
    with pytest.raises(REJECT):
        s.read(name)


def test_ac2_traversal_write_rejected(env):
    s, root, outside = env
    with pytest.raises(REJECT):
        s.write("../outside.txt", "PWNED")
    assert outside.read_text() == "SECRET"
    with pytest.raises(REJECT):
        s.write("../escaped.txt", "x")
    assert not (root.parent / "escaped.txt").exists()


def test_ac3_absolute_paths_rejected(env):
    s, _, outside = env
    with pytest.raises(REJECT):
        s.read(str(outside))
    with pytest.raises(REJECT):
        s.write(str(outside), "PWNED")
    assert outside.read_text() == "SECRET"


def test_ac4_symlink_escape_rejected(env):
    s, root, outside = env
    os.symlink(outside, root / "link")
    with pytest.raises(REJECT):
        s.read("link")
    with pytest.raises(REJECT):
        s.write("link", "PWNED")
    assert outside.read_text() == "SECRET"


def test_ac4_symlinked_dir_escape_rejected(env, tmp_path):
    s, root, _ = env
    (tmp_path / "odir").mkdir(); (tmp_path / "odir" / "f").write_text("SECRET")
    os.symlink(tmp_path / "odir", root / "d")
    with pytest.raises(REJECT):
        s.read("d/f")
