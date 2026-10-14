/* ============================================================
   The Coin — service worker

   The whole app is a shell: three text files, a manifest and an
   icon. The audio is synthesised at runtime, so there is no media
   to cache. That means "offline" here is trivially complete — the
   coin works on a plane, in a tunnel, with the radio off.

   Bump VERSION whenever you change script.js / styles.css / pwa.js.
   ============================================================ */

'use strict';

var VERSION       = 'v1';
var SHELL_CACHE   = 'afa-shell-' + VERSION;
var RUNTIME_CACHE = 'afa-runtime-' + VERSION;

var SHELL = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon.svg'
];

/* ------------------------------------------------------------
   Install — pre-cache the shell.
   Each file is added individually so a single missing asset
   (say, an icon you haven't generated yet) can't fail the whole
   install and leave the app with no service worker at all.
   ------------------------------------------------------------ */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () {
          /* optional asset — ignore */
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* ------------------------------------------------------------
   Activate — drop caches from previous versions.
   ------------------------------------------------------------ */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== RUNTIME_CACHE) {
          return caches.delete(key);
        }
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ------------------------------------------------------------
   Fetch
   ------------------------------------------------------------ */
self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only GETs, only same-origin. Everything else goes to the network.
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to the cached shell.
  // This is what makes a cold offline launch work.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) {
          c.put('./index.html', copy);
        });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (cached) {
          return cached || caches.match('./');
        });
      })
    );
    return;
  }

  // Assets: cache-first, revalidate in the background.
  // Instant loads; updates land on the *next* visit.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var fromNetwork = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (c) {
            c.put(req, copy);
          });
        }
        return res;
      }).catch(function () {
        return cached;
      });

      return cached || fromNetwork;
    })
  );
});