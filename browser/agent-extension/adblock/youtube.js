(() => {
  const SKIP_BUTTONS = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-overlay-close-button';
  const ENFORCEMENT_DIALOG = 'ytd-enforcement-message-view-model';

  function skipAd() {
    const player = document.querySelector('.html5-video-player');
    if (!player || !player.classList.contains('ad-showing')) return;
    const video = player.querySelector('video');
    if (video) {
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
    }
    document.querySelectorAll(SKIP_BUTTONS).forEach((button) => button.click());
  }

  function dismissEnforcement() {
    const dialog = document.querySelector(ENFORCEMENT_DIALOG);
    if (!dialog) return;
    const popup = dialog.closest('tp-yt-paper-dialog');
    if (popup) popup.remove();
    document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((el) => el.remove());
    const video = document.querySelector('.html5-video-player video');
    if (video && video.paused) video.play().catch(() => {});
  }

  let scheduled = false;
  const check = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; skipAd(); dismissEnforcement(); });
  };
  new MutationObserver(check).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class']
  });
  setInterval(check, 500);
})();
