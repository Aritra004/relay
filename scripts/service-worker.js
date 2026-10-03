// Build replaces these tokens with this deployment's immutable asset list.
const SHELL_CACHE = __CACHE_NAME__;
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  // Installation succeeds only when the complete shell is available offline.
  // No skipWaiting: an update must not mix a new shell with an older open tab.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        cache.addAll(
          PRECACHE.map((url) => new Request(url, { cache: "reload" })),
        ),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) => key.startsWith("relay-shell-") && key !== SHELL_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const workspaceNavigation = request.mode === "navigate" && /^\/workspaces\/[0-9a-f-]{36}\/?$/i.test(url.pathname);
  if (workspaceNavigation) {
    // Cache only the public generic shell, never personalized route HTML or APIs.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) return response;
        if (response.status < 500) return response;
      } catch { /* A disconnected navigation opens the same URL from local data. */ }
      return (await cache.match("/offline")) ?? Response.error();
    })());
    return;
  }
  const navigation = request.mode === "navigate" && ["/", "/offline"].includes(url.pathname);
  // Never cache APIs, mutation requests, or Next's RSC responses as HTML.
  if (!navigation && !PRECACHE.includes(url.pathname)) return;
  if (!navigation && request.headers.get("RSC") === "1") return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      return (
        (await cache.match(url.pathname)) ?? fetch(request)
      );
    })(),
  );
});
