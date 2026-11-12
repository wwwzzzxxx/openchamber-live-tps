/** Patch only changed values, and let the status section skip redundant layout reads. */
export function createView() {
  let dirty = false;
  return {
    text(element: HTMLElement, value: string): void {
      if (element.textContent === value) return;
      element.textContent = value;
      dirty = true;
    },
    className(element: HTMLElement, value: string): void {
      if (element.className === value) return;
      element.className = value;
      dirty = true;
    },
    hidden(element: HTMLElement, value: boolean): void {
      if (element.hidden === value) return;
      element.hidden = value;
      dirty = true;
    },
    width(element: HTMLElement, value: string): void {
      if (element.style.width === value) return;
      element.style.width = value;
      dirty = true;
    },
    takeChanges(): boolean {
      const changed = dirty;
      dirty = false;
      return changed;
    },
  };
}

/** UI polling is independent of the always-running service's data collection. */
export function createRefreshLoop(
  root: Element,
  poll: () => Promise<void>,
  onVisibility: (visible: boolean) => void,
) {
  let started = false;
  let pageShown = true;
  let intersecting = true;
  let visible = false;
  let active = true;
  let running = false;
  let wakePending = false;
  let timer: number | null = null;

  const cancel = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const schedule = (): void => {
    cancel();
    if (visible) timer = window.setTimeout(() => { void run(); }, active ? 250 : 1_000);
  };
  const run = async (): Promise<void> => {
    cancel();
    if (!visible || running) return;
    running = true;
    try {
      await poll();
    } finally {
      running = false;
      const again = wakePending;
      wakePending = false;
      if (visible) {
        if (again) void run();
        else schedule();
      }
    }
  };
  const wake = (): void => {
    if (!visible) return;
    cancel();
    if (running) wakePending = true;
    else void run();
  };
  const syncVisibility = (): void => {
    const next = started && pageShown && !document.hidden && intersecting;
    if (next === visible) return;
    visible = next;
    onVisibility(visible);
    cancel();
    if (visible) wake();
  };

  return {
    get visible(): boolean { return visible; },
    setActive(next: boolean): void {
      if (next === active) return;
      active = next;
      if (!running) schedule();
    },
    wake,
    start(): void {
      if (started) return;
      started = true;
      document.addEventListener('visibilitychange', syncVisibility);
      window.addEventListener('pagehide', () => { pageShown = false; syncVisibility(); });
      window.addEventListener('pageshow', () => { pageShown = true; syncVisibility(); });
      // A collapsed iframe does not change document.hidden. Observe its content
      // as well, so a closed section does not keep polling an otherwise visible app.
      if (typeof IntersectionObserver !== 'undefined') {
        const observer = new IntersectionObserver((entries) => {
          const entry = entries.find((item) => item.target === root);
          if (!entry) return;
          intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
          syncVisibility();
        });
        observer.observe(root);
      }
      syncVisibility();
    },
  };
}
