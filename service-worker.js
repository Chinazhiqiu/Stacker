// ============================================================
// 第三部分：Service Worker - service-worker.js (离线支持)
// 优化：移除不存在的styles.css、升级缓存版本
// ============================================================

const CACHE_NAME = 'pc28-elite-v2';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/database-manager.js',
  '/worker.js'
];

// 安装阶段
self.addEventListener('install', event => {
  console.log('[Service Worker] 安装中...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Service Worker] 缓存资源');
      // 使用 addAll 的容错版本：逐个缓存，跳过失败的资源
      return Promise.allSettled(
        URLS_TO_CACHE.map(url => cache.add(url))
      );
    })
  );
  self.skipWaiting();
});

// 激活阶段
self.addEventListener('activate', event => {
  console.log('[Service Worker] 激活中...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] 清除旧缓存', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 网络请求拦截
self.addEventListener('fetch', event => {
  const { request } = event;

  // API请求 - 网络优先，离线时使用缓存
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // 缓存成功的响应
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // 网络失败，尝试从缓存获取
          return caches.match(request).then(cachedResponse => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // 返回离线标识
            return new Response(JSON.stringify({ offline: true, code: 1 }), {
              headers: { 'Content-Type': 'application/json' }
            });
          });
        })
    );
  }
  // 静态资源 - 缓存优先
  else {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        });
      })
    );
  }
});

// 后台同步（当网络恢复时）
self.addEventListener('sync', event => {
  if (event.tag === 'sync-predictions') {
    event.waitUntil(
      (async () => {
        try {
          // 从IndexedDB获取待同步的预测
          // 发送到服务器
          console.log('[Service Worker] 执行后台同步');
        } catch (err) {
          console.error('[Service Worker] 同步失败', err);
        }
      })()
    );
  }
});
