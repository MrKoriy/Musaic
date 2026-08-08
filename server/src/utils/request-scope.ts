import { AsyncLocalStorage } from "node:async_hooks";

const userScope = new AsyncLocalStorage<string | null>();

export function currentRequestUserId(): string | null {
  return userScope.getStore() ?? null;
}

export function runWithRequestUser<T>(userId: string | null, work: () => T): T {
  return userScope.run(userId, work);
}
