(() => {
  const LABELS = new Set(['sponsored', 'sponsored result', 'sponsored results', 'sponsored product', 'sponsored products',
    'sponsored ad', 'sponsored ads']);
  const COLUMNS = '#rso, #tvcap, #taw, #tads, #tadsb, #bottomads, #botstuff, #rhs, #center_col, #search, [role="main"]';
  const NEVER = '#rso, #search, #center_col, #rcnt, #main, #cnt, #rhs, [role="main"], body, html';

  function blockFor(label) {
    let el = label;
    while (el.parentElement && !el.parentElement.matches(COLUMNS)) el = el.parentElement;
    return el.parentElement && !el.matches(NEVER) ? el : null;
  }

  function sweep() {
    const root = document.getElementById('rcnt') || document.getElementById('main');
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.data.length < 30 && LABELS.has(n.data.trim().toLowerCase()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = node.parentElement && blockFor(node.parentElement);
      if (block) block.style.setProperty('display', 'none', 'important');
    }
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; sweep(); }, 50);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', sweep);
})();
