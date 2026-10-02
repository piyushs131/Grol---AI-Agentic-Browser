(() => {
  const w = window;
  const noop = () => {};
  const later = (fn) => { if (typeof fn === 'function') setTimeout(() => { try { fn(); } catch (_) {} }, 1); };

  function settle(item) {
    if (!item) return;
    later(item.eventCallback);
    if (typeof item === 'object' && item[0] === 'event' && item[2]) later(item[2].event_callback);
  }

  const dataLayer = Array.isArray(w.dataLayer) ? w.dataLayer : (w.dataLayer = []);
  dataLayer.forEach(settle);
  const push = Array.prototype.push;
  dataLayer.push = function (...items) { items.forEach(settle); return push.apply(this, items); };

  const container = { dataLayer: { get: noop, set: noop, reset: noop }, onHtmlSuccess: noop, onHtmlFailure: noop };
  if (!w.google_tag_manager) w.google_tag_manager = new Proxy({}, { get: (_, key) => (key === 'dataLayer' ? container.dataLayer : container) });
  if (typeof w.gtag !== 'function') w.gtag = function () { dataLayer.push(arguments); };
})();
