// ============================================================
// 第一部分：核心 - database-manager.js (IndexedDB管理)
// ============================================================

class DatabaseManager {
  constructor(dbName = 'pc28-elite', version = 2) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this.isReady = false;
  }

  /**
   * 初始化数据库
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.isReady = true;
        console.log('✅ IndexedDB初始化成功');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // 创建存储空间
        const stores = {
          'draws': { keyPath: 'period', autoIncrement: false },
          'predictions': { keyPath: 'id', autoIncrement: true },
          'cache': { keyPath: 'key' },
          'syncQueue': { keyPath: 'id', autoIncrement: true },
          'statistics': { keyPath: 'key' }
        };

        Object.entries(stores).forEach(([name, config]) => {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, config);
            // 创建索引
            if (name === 'draws') {
              store.createIndex('period', 'period', { unique: false });
              store.createIndex('timestamp', 'timestamp', { unique: false });
            }
            if (name === 'predictions') {
              store.createIndex('createdAt', 'createdAt', { unique: false });
              store.createIndex('type', 'type', { unique: false });
            }
          }
        });

        // v2 升级：如果 draws store 存在但 keyPath 不对，需要重建
        if (oldVersion < 2 && db.objectStoreNames.contains('draws')) {
          // 旧版本用 id 作 keyPath，新版本用 period 去重
          // 注意：IndexedDB 不支持修改已有 store 的 keyPath
          // 如果需要从 v1 升级，需要删除并重建
          try {
            db.deleteObjectStore('draws');
            const store = db.createObjectStore('draws', { keyPath: 'period' });
            store.createIndex('period', 'period', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            console.log('✅ draws store 已升级（keyPath: period）');
          } catch (e) {
            console.warn('⚠️ draws store 升级失败:', e);
          }
        }

        console.log('✅ 数据库架构创建成功');
      };
    });
  }

  /**
   * 事务操作基类
   */
  async transaction(storeName, mode = 'readonly', callback) {
    if (!this.isReady) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);

        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve();

        callback(store);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 保存开奖数据（使用 period 作为主键，自动去重）
   */
  async saveDraw(draw) {
    return new Promise((resolve, reject) => {
      this.transaction('draws', 'readwrite', (store) => {
        const request = store.put({
          ...draw,
          timestamp: draw.timestamp || Date.now()
        });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 批量保存开奖数据（单事务，性能优化）
   */
  async batchSaveDraws(draws) {
    return new Promise((resolve, reject) => {
      let savedCount = 0;
      this.transaction('draws', 'readwrite', (store) => {
        draws.forEach(draw => {
          const request = store.put({
            ...draw,
            timestamp: draw.timestamp || Date.now()
          });
          request.onsuccess = () => { savedCount++; };
        });
      }).then(() => {
        console.log(`✅ 批量保存 ${savedCount} 条开奖数据`);
        resolve(savedCount);
      }).catch(reject);
    });
  }

  /**
   * 获取最近N条开奖记录
   */
  async getRecentDraws(limit = 100) {
    return new Promise((resolve, reject) => {
      const results = [];
      this.transaction('draws', 'readonly', (store) => {
        const index = store.index('timestamp');
        const range = IDBKeyRange.lowerBound(0);
        const request = index.openCursor(range, 'prev');

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value);
            cursor.continue();
          }
        };
        request.onerror = () => reject(request.error);
      }).then(() => resolve(results)).catch(reject);
    });
  }

  /**
   * 保存预测结果
   */
  async savePrediction(prediction) {
    return new Promise((resolve, reject) => {
      this.transaction('predictions', 'readwrite', (store) => {
        const request = store.put({
          ...prediction,
          id: Date.now(),
          createdAt: Date.now()
        });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 获取所有预测记录
   */
  async getAllPredictions() {
    return new Promise((resolve, reject) => {
      this.transaction('predictions', 'readonly', (store) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 缓存管理
   */
  async setCache(key, value, ttl = 3600000) {
    return new Promise((resolve, reject) => {
      this.transaction('cache', 'readwrite', (store) => {
        const request = store.put({
          key,
          value,
          expiresAt: Date.now() + ttl
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 获取缓存
   */
  async getCache(key) {
    return new Promise((resolve, reject) => {
      this.transaction('cache', 'readonly', (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const result = request.result;
          if (result && result.expiresAt > Date.now()) {
            resolve(result.value);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 同步队列 - 离线时保存待发送的操作
   */
  async queueSync(operation) {
    return new Promise((resolve, reject) => {
      this.transaction('syncQueue', 'readwrite', (store) => {
        const request = store.put({
          ...operation,
          queuedAt: Date.now(),
          status: 'pending'
        });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 获取待同步的操作
   */
  async getPendingSyncOperations() {
    return new Promise((resolve, reject) => {
      this.transaction('syncQueue', 'readonly', (store) => {
        const request = store.getAll();
        request.onsuccess = () => {
          resolve(request.result.filter(op => op.status === 'pending'));
        };
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 清空过期缓存
   */
  async cleanExpiredCache() {
    return new Promise((resolve, reject) => {
      this.transaction('cache', 'readwrite', (store) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const now = Date.now();
          const expired = request.result.filter(item => item.expiresAt < now);
          expired.forEach(item => store.delete(item.key));
          resolve(expired.length);
        };
        request.onerror = () => reject(request.error);
      }).catch(reject);
    });
  }

  /**
   * 获取数据库统计信息
   */
  async getStats() {
    const stats = {};
    const stores = ['draws', 'predictions', 'cache', 'syncQueue'];

    for (const storeName of stores) {
      await new Promise((resolve, reject) => {
        this.transaction(storeName, 'readonly', (store) => {
          const request = store.count();
          request.onsuccess = () => {
            stats[storeName] = request.result;
            resolve();
          };
          request.onerror = () => reject(request.error);
        }).catch(reject);
      });
    }

    return stats;
  }

  /**
   * 导出数据（用于备份）
   */
  async exportData() {
    const data = {};
    const stores = ['draws', 'predictions', 'statistics'];

    for (const storeName of stores) {
      await new Promise((resolve, reject) => {
        this.transaction(storeName, 'readonly', (store) => {
          const request = store.getAll();
          request.onsuccess = () => {
            data[storeName] = request.result;
            resolve();
          };
          request.onerror = () => reject(request.error);
        }).catch(reject);
      });
    }

    return data;
  }

  /**
   * 导入数据（从备份文件恢复）
   */
  async importData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('无效的数据格式');
    }

    const results = {};
    const importableStores = ['draws', 'predictions', 'statistics'];

    for (const storeName of importableStores) {
      if (!Array.isArray(data[storeName])) continue;

      let count = 0;
      await new Promise((resolve, reject) => {
        this.transaction(storeName, 'readwrite', (store) => {
          data[storeName].forEach(item => {
            const request = store.put(item);
            request.onsuccess = () => { count++; };
            request.onerror = () => console.warn(`⚠️ 导入 ${storeName} 单条数据失败`);
          });
        }).then(() => {
          results[storeName] = count;
          resolve();
        }).catch(reject);
      });
    }

    console.log('✅ 数据导入完成:', results);
    return results;
  }

  /**
   * 清空所有数据
   */
  async clearAll() {
    const stores = ['draws', 'predictions', 'cache', 'syncQueue', 'statistics'];

    for (const storeName of stores) {
      await new Promise((resolve, reject) => {
        this.transaction(storeName, 'readwrite', (store) => {
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }).catch(reject);
      });
    }

    console.log('✅ 所有数据已清空');
    return true;
  }
}
