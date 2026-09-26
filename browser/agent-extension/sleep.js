// A sleep that ends early when the task is stopped, so a long backoff never
// keeps a stopped task alive. isAborted is polled because callers track stop
// with a flag; signal is honoured as well.
const POLL_MS = 100;

export function sleep(ms, { signal, isAborted } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted || isAborted?.()) return resolve();
    let poll = null;
    const done = () => {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    if (isAborted) poll = setInterval(() => { if (isAborted()) done(); }, POLL_MS);
    signal?.addEventListener('abort', done, { once: true });
  });
}
