import { expect, test } from "bun:test";
import { fetchWithRetry } from "../src/model";

const noSleep = async () => {};
function seq(items: Array<number | Error>) {
  let calls = 0;
  const impl = (async () => {
    const item = items[Math.min(calls++, items.length - 1)]!;
    if (item instanceof Error) throw item;
    return new Response("{}", { status: item });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

test("retries 429, 5xx and network errors then succeeds", async () => {
  const s = seq([429, 503, Error("ECONNRESET"), 200]);
  const r = await fetchWithRetry("http://x", {}, new AbortController().signal, {
    fetchImpl: s.impl, sleep: noSleep, attempts: 5,
  });
  expect(r.status).toBe(200);
  expect(s.calls()).toBe(4);
});

test("does not retry 4xx client errors", async () => {
  const s = seq([400, 200]);
  const r = await fetchWithRetry("http://x", {}, new AbortController().signal, {
    fetchImpl: s.impl, sleep: noSleep,
  });
  expect(r.status).toBe(400);
  expect(s.calls()).toBe(1);
});

test("gives up after the attempt limit", async () => {
  const s = seq([500]);
  const r = await fetchWithRetry("http://x", {}, new AbortController().signal, {
    fetchImpl: s.impl, sleep: noSleep, attempts: 3,
  });
  expect(r.status).toBe(500);
  expect(s.calls()).toBe(3);
  const e = seq([Error("down")]);
  await expect(fetchWithRetry("http://x", {}, new AbortController().signal, {
    fetchImpl: e.impl, sleep: noSleep, attempts: 2,
  })).rejects.toThrow("down");
  expect(e.calls()).toBe(2);
});

test("stops retrying once aborted", async () => {
  const c = new AbortController();
  const s = seq([Error("down")]);
  c.abort();
  await expect(fetchWithRetry("http://x", {}, c.signal, { fetchImpl: s.impl, sleep: noSleep })).rejects.toThrow();
  expect(s.calls()).toBe(1);
});
