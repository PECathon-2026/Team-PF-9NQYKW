"""A tiny file-backed note store. Each note is a file named after the note."""
import os


class NoteStore:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)

    def _path(self, name):
        return os.path.join(self.root, name)

    def write(self, name, text):
        with open(self._path(name), "w", encoding="utf-8") as f:
            f.write(text)

    def read(self, name):
        with open(self._path(name), encoding="utf-8") as f:
            return f.read()

    def list(self):
        return sorted(
            n for n in os.listdir(self.root) if os.path.isfile(os.path.join(self.root, n))
        )
