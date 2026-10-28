import { expect, test } from "bun:test";
import { CatalogService } from "../src/catalog-service.ts";
import type { Catalog } from "../src/catalog.ts";
const snapshot = (name: string): Catalog => ({ relations: [], schemas: [name], keywords: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("catalog is single-flight, cached, expires and retries failures without stale metadata", async () => {
  let now = 0,
    reads = 0,
    unavailable = 0,
    changed = 0,
    fail = false;
  const service = new CatalogService(() => unavailable++, {
    now: () => now,
    changed: () => changed++,
    load: async () => {
      reads++;
      if (fail) throw Error();
      return snapshot(String(reads));
    },
  });
  const [a, b] = await Promise.all([service.get(), service.get()]);
  expect(a).toBe(b);
  expect(reads).toBe(1);
  expect(changed).toBe(1);
  now = 59_999;
  await service.get();
  expect(reads).toBe(1);
  now = 60_000;
  await service.get();
  expect(reads).toBe(2);
  fail = true;
  await service.refresh();
  expect(service.peek().schemas).toEqual([]);
  expect(unavailable).toBe(1);
  await service.get();
  expect(reads).toBe(3);
  fail = false;
  now += 5000;
  await service.get();
  expect(reads).toBe(4);
  service.stop();
  expect((await service.get()).schemas).toEqual([]);
});
test("save during an in-flight catalog read discards pre-migration results", async () => {
  const old = deferred<Catalog>(),
    fresh = deferred<Catalog>();
  let reads = 0,
    changed = 0;
  const service = new CatalogService(() => {}, {
    changed: () => changed++,
    load: () => (++reads === 1 ? old.promise : fresh.promise),
  });
  const a = service.get(),
    b = service.refresh();
  old.resolve(snapshot("old"));
  await Promise.resolve();
  expect(service.peek().schemas).toEqual([]);
  fresh.resolve(snapshot("fresh"));
  expect((await a).schemas).toEqual(["fresh"]);
  expect(await b).toBe(await a);
  expect(reads).toBe(2);
  expect(changed).toBe(1);
  service.stop();
});
test("stopping an in-flight catalog read prevents later publication", async () => {
  const task = deferred<Catalog>();
  let changes = 0;
  const service = new CatalogService(() => {}, {
    load: () => task.promise,
    changed: () => changes++,
  });
  const p = service.get();
  service.stop();
  task.resolve(snapshot("late"));
  expect((await p).schemas).toEqual([]);
  expect(changes).toBe(0);
});
