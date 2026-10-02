(() => {
  const w = window;
  const later = (fn) => { if (typeof fn === 'function') setTimeout(() => { try { fn(tracker); } catch (_) {} }, 1); };
  const tracker = { get: () => undefined, set: () => {}, send: (...args) => args.forEach((a) => a && later(a.hitCallback)) };

  function ga(...args) {
    if (typeof args[0] === 'function') return later(args[0]);
    args.forEach((a) => a && typeof a === 'object' && later(a.hitCallback));
  }
  Object.assign(ga, { create: () => tracker, getByName: () => tracker, getAll: () => [tracker], remove: () => {}, loaded: true });

  const name = w.GoogleAnalyticsObject || 'ga';
  const queued = w[name] && Array.isArray(w[name].q) ? w[name].q : [];
  w[name] = ga;
  queued.forEach((args) => ga(...args));

  if (!w._gaq || Array.isArray(w._gaq)) {
    const legacy = Array.isArray(w._gaq) ? w._gaq : [];
    w._gaq = { push: (...items) => items.forEach((i) => typeof i === 'function' && later(i)) };
    legacy.forEach((i) => w._gaq.push(i));
  }
})();
