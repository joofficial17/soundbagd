/**
 * Soundbagd Service Worker
 *
 * Strategy:
 *  - Static assets (HTML, CSS, JS, icons): Cache-first, update in background
 *  - API calls (/api/*): Network-first, fall back to cache if offline
 *  - External (iTunes, Spotify, images): Network-only (no stale music data)
 */

const CACHE_VERSION = 'soundbagd-v1';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/album.html',
  '/community.html',
  '/profile.html',
  '/ratings.html',
  '/recommendations.html',
  '/style.css',
  '/app.js',
  '/icons/icon.svg',
  '/manifest.json',
];

// ── Install: pre-cache all static assets ──────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('soundbagd-') && key !== STATIC_CACHE && key !== API_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: route requests by type ────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests we don't control
  if (request.method !== 'GET') return;

  // External music APIs — always network, never cache
  if (
    url.hostname.includes('itunes.apple.com') ||
    url.hostname.includes('api.spotify.com') ||
    url.hostname.includes('ws.audioscrobbler.com') ||
    url.hostname.includes('api.deezer.com') ||
    url.hostname.includes('is1-ssl.mzstatic.com') ||
    url.hostname.includes('i.scdn.co')
  ) {
    return; // fall through to normal browser fetch
  }

  // Our API calls — network first, cache as offline fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Only cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(API_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request)) // offline: return cached API response
    );
    return;
  }

  // Static assets — cache first, network fallback, update in background
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
      return cached || networkFetch;
    })
  );
});
