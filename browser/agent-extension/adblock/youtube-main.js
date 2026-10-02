(() => {
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const MAX_DEPTH = 6;

  const isAdEntry = (e) => !!(e && e.command && e.command.reelWatchEndpoint
    && e.command.reelWatchEndpoint.adClientParams && e.command.reelWatchEndpoint.adClientParams.isAd);

  function prune(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) delete value[key];
    }
    if (Array.isArray(value.entries)) value.entries = value.entries.filter((e) => !isAdEntry(e));
    for (const key of ['playerResponse', 'response', 'data']) {
      if (value[key] && typeof value[key] === 'object') prune(value[key], depth + 1);
    }
    if (Array.isArray(value)) value.forEach((item) => prune(item, depth + 1));
    return value;
  }

  const safePrune = (value) => { try { return prune(value); } catch (_) { return value; } };

  const parse = JSON.parse;
  JSON.parse = function (...args) { return safePrune(parse.apply(this, args)); };

  const json = Response.prototype.json;
  Response.prototype.json = function (...args) { return json.apply(this, args).then(safePrune); };

  for (const name of ['ytInitialPlayerResponse', 'ytInitialData']) {
    let current;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => current,
        set: (v) => { current = safePrune(v); }
      });
    } catch (_) {}
  }
})();
