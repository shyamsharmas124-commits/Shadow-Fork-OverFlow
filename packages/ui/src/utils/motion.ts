export function isReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function startViewTransition(callback: () => void) {
  if (typeof document !== "undefined" && "startViewTransition" in document && !isReducedMotion()) {
    try {
      const transition = (
        document as unknown as {
          startViewTransition: (cb: () => void) => {
            finished?: Promise<void>;
            ready?: Promise<void>;
            updateCallbackDone?: Promise<void>;
          };
        }
      ).startViewTransition(callback);

      transition.finished?.catch(() => {});
      transition.ready?.catch(() => {});
      transition.updateCallbackDone?.catch(() => {});
    } catch {
      callback();
    }
  } else {
    callback();
  }
}
