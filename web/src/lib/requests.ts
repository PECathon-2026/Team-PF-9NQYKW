// Public request strings only, copied from fixtures/registry.json. No suite paths or digests.
import type { RepoId } from "./types";
export const REQUESTS: Record<RepoId, string> = {
  cart: "Add a discount-code feature to the cart: support percentage codes and fixed-amount codes. Cart.apply_discount(('percent', n)) with 0<=n<=100 or Cart.apply_discount(('fixed', cents)) with cents>=0; total() applies the discount and must never go below 0; invalid codes raise ValueError; remove_discount() clears it and applying a new code replaces the old one. Existing behavior must keep working.",
  stats: "Investigate the defect marked `# bug` in stats.py and fix it if confirmed.",
  stock: "reserve(qty, available) rejects valid reservations; a test is failing. Fix the defect.",
  notes: "Review the note store for security issues and fix any path-handling problems so notes cannot be read or written outside the store root (including absolute paths and symlinks), while normal notes keep working.",
  titles: "clean up the titles",
};
