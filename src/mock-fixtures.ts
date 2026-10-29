/** Deterministic scripted responses for the supplied public fixture scenarios. */
const message = (value: unknown) => ({
  role: "assistant",
  content: JSON.stringify(value),
});
const call = (name: string, args: unknown, id: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

export function fixtureScript(
  repo: string,
  request: string,
): Record<string, any[]> {
  if (repo === "titles") {
    const clarify = [
      call("search", { path: ".", query: "title" }, "titles-search"),
      message({
        blocked: true,
        question:
          "What changes should be made to title formatting and slug generation?",
      }),
    ];
    return { shogun: clarify, baseline: clarify };
  }
  const edits: Record<
    string,
    { path: string; old_text: string; new_text: string }[]
  > = {
    stock: [
      {
        path: "stock.py",
        old_text: "if qty >= available:",
        new_text: "if qty > available:",
      },
    ],
    stats: [
      {
        path: "stats.py",
        old_text: "return total(values) // len(values)  # bug",
        new_text: "return total(values) / len(values)",
      },
    ],
    cart: [
      {
        path: "cart.py",
        old_text: "self._items = {}  # name -> [unit_price_cents, qty]",
        new_text:
          "self._items = {}  # name -> [unit_price_cents, qty]\n        self._discount = None",
      },
      {
        path: "cart.py",
        old_text: "    def total(self):\n        return self.subtotal()",
        new_text: `    def apply_discount(self, code):
        if not isinstance(code, tuple) or len(code) != 2:
            raise ValueError("invalid discount")
        kind, amount = code
        if kind not in ("percent", "fixed") or not isinstance(amount, int) or isinstance(amount, bool):
            raise ValueError("invalid discount")
        if amount < 0 or (kind == "percent" and amount > 100):
            raise ValueError("invalid discount")
        self._discount = code

    def remove_discount(self):
        self._discount = None

    def total(self):
        total = self.subtotal()
        if self._discount is None:
            return total
        kind, amount = self._discount
        if kind == "percent":
            return total - total * amount // 100
        return max(0, total - amount)`,
      },
    ],
    notes: [
      {
        path: "notes.py",
        old_text: "        return os.path.join(self.root, name)",
        new_text: `        if not isinstance(name, str) or not name or os.path.isabs(name):
            raise ValueError("invalid note path")
        parts = name.replace("\\\\", "/").split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ValueError("invalid note path")
        path = os.path.join(self.root, *parts)
        current = self.root
        for part in parts:
            current = os.path.join(current, part)
            if os.path.islink(current):
                raise ValueError("symlinks are not permitted")
        if os.path.commonpath((self.root, os.path.realpath(path))) != self.root:
            raise ValueError("note path escapes root")
        return path`,
      },
    ],
  };
  const selected = edits[repo];
  if (!selected) return {};
  const plan = [
    message({
      criteria: [{ id: `${repo}.acceptance`, description: request }],
      tasks: [{ id: "implement", title: request }],
    }),
  ];
  const editor = [
    call("read_file", { path: selected[0]!.path }, `${repo}-read`),
    ...selected.map((edit, i) => call("edit_file", edit, `${repo}-edit-${i}`)),
    message({ done: true }),
  ];
  const review = [
    call("read_file", { path: selected[0]!.path }, `${repo}-review`),
    message({ findings: [] }),
  ];
  const security = [message({ findings: [] })];
  return {
    shogun: plan,
    samurai: editor,
    shadow_review: review,
    shadow_security: security,
    baseline: [...plan, ...editor, ...review],
  };
}
