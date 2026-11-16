import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

export class ShadowEgressError extends Error {
  constructor(target: string) {
    super(`Shadow egress violation: blocked direct network egress to ${target} in shadow mode.`);
    this.name = "ShadowEgressError";
  }
}

interface ShadowStore {
  inShadow: boolean;
}

const shadowStorage = new AsyncLocalStorage<ShadowStore>();

let installed = false;

/**
 * Installs egress guard monkey-patching global fetch, http.request, http.get,
 * https.request, and https.get when called inside a shadow execution context.
 */
export function installEgressGuard(): void {
  if (installed) return;
  installed = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function shadowGuardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const store = shadowStorage.getStore();
    if (store?.inShadow) {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      throw new ShadowEgressError(`fetch(${urlStr})`);
    }
    return originalFetch.call(this, input, init);
  };

  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;

  const httpMod = http as unknown as {
    request: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
  const httpsMod = https as unknown as {
    request: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };

  const origHttpReqFn = originalHttpRequest as (...a: unknown[]) => unknown;
  const origHttpGetFn = originalHttpGet as (...a: unknown[]) => unknown;
  const origHttpsReqFn = originalHttpsRequest as (...a: unknown[]) => unknown;
  const origHttpsGetFn = originalHttpsGet as (...a: unknown[]) => unknown;

  httpMod.request = function shadowGuardedHttpRequest(...args: unknown[]) {
    const store = shadowStorage.getStore();
    if (store?.inShadow) {
      throw new ShadowEgressError("node:http request");
    }
    return origHttpReqFn.apply(this, args);
  };

  httpMod.get = function shadowGuardedHttpGet(...args: unknown[]) {
    const store = shadowStorage.getStore();
    if (store?.inShadow) {
      throw new ShadowEgressError("node:http get");
    }
    return origHttpGetFn.apply(this, args);
  };

  httpsMod.request = function shadowGuardedHttpsRequest(...args: unknown[]) {
    const store = shadowStorage.getStore();
    if (store?.inShadow) {
      throw new ShadowEgressError("node:https request");
    }
    return origHttpsReqFn.apply(this, args);
  };

  httpsMod.get = function shadowGuardedHttpsGet(...args: unknown[]) {
    const store = shadowStorage.getStore();
    if (store?.inShadow) {
      throw new ShadowEgressError("node:https get");
    }
    return origHttpsGetFn.apply(this, args);
  };

  syncBuiltinESMExports();
}

/**
 * Runs a function inside the shadow execution context.
 */
export function runInShadowContext<T>(fn: () => T): T {
  installEgressGuard();
  return shadowStorage.run({ inShadow: true }, fn);
}
