(function () {
  'use strict';

  /* ============================================================
     1. SERVICE WORKER
     ============================================================ */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { scope: './' })
        .catch(function (err) {
          console.warn('[pwa] service worker registration failed:', err);
        });
    });
  }

  /* ============================================================
     2. INSTALL BANNER
     ============================================================ */

  var banner   = document.getElementById('install');
  var textEl   = document.getElementById('installText');
  var btn      = document.getElementById('installBtn');
  var closeBtn = document.getElementById('installClose');

  if (!banner || !textEl || !btn || !closeBtn) return;

  var DISMISS_KEY   = 'afa.install.dismissedAt';
  var INSTALLED_KEY = 'afa.install.installed';
  var DISMISS_MS    = 7 * 24 * 60 * 60 * 1000;   // re-offer after a week
  var IOS_DELAY_MS  = 3500;

  var deferred = null;   // the captured beforeinstallprompt event
  var visible  = false;

  /* -- storage (private mode throws — never let it break the page) -- */

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /* -- state -- */

  function isStandalone() {
    return (window.matchMedia &&
            window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }

  function alreadyInstalled() {
    return isStandalone() || read(INSTALLED_KEY) === '1';
  }

  function dismissedRecently() {
    var t = parseInt(read(DISMISS_KEY) || '0', 10);
    return t > 0 && (Date.now() - t) < DISMISS_MS;
  }

  function canOffer() {
    return !alreadyInstalled() && !dismissedRecently();
  }

  /* -- show / hide -- */

  function show() {
    if (visible) return;
    visible = true;
    banner.classList.add('show');
    banner.setAttribute('aria-hidden', 'false');
  }

  function hide() {
    if (!visible) return;
    visible = false;
    banner.classList.remove('show');
    banner.setAttribute('aria-hidden', 'true');
  }

  /* -- keep the banner from stealing the coin's own gestures --
     script.js flips on document-level pointerdown / keydown. The
     banner stops those before they bubble, so "Install" and "×"
     never flip the coin. No edits to script.js required.          */

  banner.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  banner.addEventListener('keydown',     function (e) { e.stopPropagation(); });

  /* -- 2a. Android / desktop Chrome, Edge, Samsung, etc. -- */

  window.addEventListener('beforeinstallprompt', function (e) {
    // Suppress the browser's own mini-infobar so we control the moment.
    e.preventDefault();
    deferred = e;

    if (canOffer()) {
      textEl.textContent = 'Install The Coin';
      btn.hidden = false;
      show();
    }
  });

  window.addEventListener('appinstalled', function () {
    store(INSTALLED_KEY, '1');
    deferred = null;
    hide();
  });

  btn.addEventListener('click', function () {
    if (!deferred) return;

    var promptEvent = deferred;
    deferred = null;
    hide();

    promptEvent.prompt();

    if (promptEvent.userChoice) {
      promptEvent.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          store(INSTALLED_KEY, '1');
        } else {
          store(DISMISS_KEY, String(Date.now()));
        }
      });
    }
  });

  closeBtn.addEventListener('click', function () {
    store(DISMISS_KEY, String(Date.now()));
    hide();
  });

  /* -- 2b. iOS Safari: no beforeinstallprompt exists, so we
        explain the Share-sheet route instead. -- */

  var ua = navigator.userAgent;
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    window.setTimeout(function () {
      // If Chrome/Edge on Android already handed us a real prompt,
      // or the user has already been asked, stay quiet.
      if (deferred || !canOffer()) return;

      textEl.textContent = 'Install: Share → Add to Home Screen';
      btn.hidden = true;
      show();
    }, IOS_DELAY_MS);
  }

  /* -- 2c. Covers the case where the app is launched standalone
        after the banner was already queued. -- */

  if (alreadyInstalled()) hide();

})();