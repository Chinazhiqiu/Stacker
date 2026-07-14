// ============================================================
// 第四部分：主应用 - app.js (前端核心应用)
// 优化：修复Worker竞态、批量写入、内存泄漏、完善导入/清空
// ============================================================

class PC28FrontendEliteApp {
  constructor() {
    this.db = new DatabaseManager();
    this.worker = null;
    this.isOnline = navigator.onLine;
    this.predictions = {};
    this.stats = {};
    this.initializeTime = Date.now();
    this._refreshIntervalId = null;
    this._isFetching = false;
    this._workerMessageCounter = 0;
    this.lastPrediction = null;
  }

  /**
   * 应用初始化
   */
  async initialize() {
    console.log('🚀 PC28前端系统初始化...');

    try {
      // 1. 初始化IndexedDB
      await this.db.initialize();

      // 2. 注册Service Worker
      if ('serviceWorker' in navigator) {
        try {
          const registration = await navigator.serviceWorker.register('/service-worker.js');
          console.log('✅ Service Worker注册成功');
        } catch (err) {
          console.warn('⚠️ Service Worker注册失败:', err);
        }
      }

      // 3. 初始化Web Worker
      this.worker = new Worker('/worker.js');
      const history = await this.db.getRecentDraws(100);
      this._postToWorker({ type: 'INIT', payload: { history } });

      // 4. 网络状态监听
      window.addEventListener('online', () => this._onOnline());
      window.addEventListener('offline', () => this._onOffline());

      // 5. 从缓存加载初始数据
      await this._loadInitialData();

      // 6. 启动自动刷新
      this._setupAutoRefresh();

      console.log('✅ 应用初始化完成');
      return { code: 0, msg: '初始化成功' };
    } catch (err) {
      console.error('❌ 初始化失败:', err);
      return { code: 1, msg: err.message };
    }
  }

  /**
   * 从缓存加载初始数据
   */
  async _loadInitialData() {
    try {
      // 尝试从缓存加载最新数据
      const cachedData = await this.db.getCache('latest-draws');
      if (cachedData) {
        console.log('📦 从缓存加载数据');
        await this._updateWorkerHistory(cachedData);
      } else {
        console.log('📊 从IndexedDB加载历史数据');
        const draws = await this.db.getRecentDraws(100);
        if (draws.length > 0) {
          await this._updateWorkerHistory(draws);
        }
      }
    } catch (err) {
      console.warn('⚠️ 加载初始数据失败:', err);
    }
  }

  /**
   * 获取实时开奖数据（带防抖，防止并发请求）
   */
  async fetchDrawData() {
    // 防抖：如果正在获取中，跳过本次请求
    if (this._isFetching) {
      console.log('⏳ 数据获取进行中，跳过重复请求');
      return { code: 0, msg: '请求被跳过（防抖）' };
    }

    this._isFetching = true;
    try {
      // 优先使用缓存（如果在线，会自动更新）
      const cachedData = await this.db.getCache('latest-draws');

      if (this.isOnline) {
        // 在线模式：从API获取最新数据
        const response = await this._fetchWithRetry('https://pc28.help/api/kj.json?nbr=100', 3);

        if (response && response.ok) {
          const data = await response.json();
          const processed = this._processDrawData(data);

          if (processed.length > 0) {
            // 批量保存到数据库（单事务，性能优化）
            await this.db.batchSaveDraws(processed);

            // 更新缓存
            await this.db.setCache('latest-draws', processed, 300000); // 5分钟有效期

            // 更新Worker
            await this._updateWorkerHistory(processed);

            return { code: 0, data: processed };
          }
        }
      }

      // 离线或网络失败：使用缓存数据
      if (cachedData) {
        console.log('📦 使用缓存数据 (离线模式)');
        return { code: 0, data: cachedData, offline: true };
      }

      // 都失败：从IndexedDB获取历史数据
      const historicalData = await this.db.getRecentDraws(50);
      if (historicalData.length > 0) {
        console.log('📊 使用历史数据 (应急模式)');
        return { code: 0, data: historicalData, fallback: true };
      }

      return { code: 1, msg: '无可用数据' };
    } catch (err) {
      console.error('❌ 获取数据失败:', err);
      return { code: 1, msg: err.message };
    } finally {
      this._isFetching = false;
    }
  }

  /**
   * 带重试的fetch
   */
  async _fetchWithRetry(url, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }
        });

        clearTimeout(timeoutId);
        return response;
      } catch (err) {
        console.warn(`⚠️ 重试 ${i + 1}/${maxRetries} 失败:`, err.message);
        if (i === maxRetries - 1) return null;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // 指数退避
      }
    }
    return null;
  }

  /**
   * 处理开奖数据
   */
  _processDrawData(data) {
    try {
      let draws = Array.isArray(data) ? data : data.data || [];

      return draws.slice(0, 100).map((item, idx) => {
        let number = item.number;

        if (typeof number === 'string') {
          if (number.includes('=')) {
            number = parseInt(number.split('=')[1]) % 28;
          } else if (number.includes('+')) {
            number = number.split('+').map(Number).reduce((a, b) => a + b) % 28;
          } else {
            number = parseInt(number) % 28;
          }
        }

        // 确保number是有效整数
        if (isNaN(number) || number < 0 || number >= 28) return null;

        return {
          period: String(item.nbr || idx),
          number: number,
          time: item.time || new Date().toLocaleString('zh-CN'),
          timestamp: Date.now()
        };
      }).filter(item => item !== null);
    } catch (err) {
      console.error('数据处理错误:', err);
      return [];
    }
  }

  /**
   * 更新Worker历史数据
   */
  async _updateWorkerHistory(history) {
    return new Promise((resolve) => {
      this._postToWorker(
        { type: 'UPDATE_HISTORY', payload: { history } },
        () => resolve()
      );
    });
  }

  /**
   * 获取综合预测
   */
  async getComprehensivePrediction() {
    try {
      // 先获取最新数据
      const drawResult = await this.fetchDrawData();
      if (drawResult.code !== 0) {
        return { code: 1, msg: '无可用数据进行预测' };
      }

      // 触发所有预测任务
      const predictions = await Promise.all([
        this._predictLuckyNumber(),
        this._predictSingleDouble(),
        this._predictBigSmall(),
        this._predictDoubleGroup(),
        this._predictKillGroup()
      ]);

      this.predictions = {
        luckyNumber: predictions[0],
        singleDouble: predictions[1],
        bigSmall: predictions[2],
        doubleGroup: predictions[3],
        killGroup: predictions[4]
      };

      // 保存最近一次预测，用于命中判定
      this.lastPrediction = {
        singleDouble: this.predictions.singleDouble?.prediction || null,
        bigSmall: this.predictions.bigSmall?.prediction || null,
        doubleGroupGroups: this.predictions.doubleGroup?.recommendation?.groups || null,
        doubleGroupLabel: this.predictions.doubleGroup?.recommendation?.label || null,
        timestamp: Date.now()
      };

      // 保存预测结果到数据库
      await this.db.savePrediction({
        type: 'comprehensive',
        results: this.predictions,
        timestamp: Date.now()
      });

      return {
        code: 0,
        data: this.predictions,
        timestamp: Date.now(),
        offline: drawResult.offline || false
      };
    } catch (err) {
      console.error('预测失败:', err);
      return { code: 1, msg: err.message };
    }
  }

  /**
   * 各种预测方法
   */
  _predictLuckyNumber() {
    return new Promise((resolve) => {
      this._postToWorker(
        { type: 'PREDICT_LUCKY' },
        (result) => resolve(result)
      );
    });
  }

  _predictSingleDouble() {
    return new Promise((resolve) => {
      this._postToWorker(
        { type: 'PREDICT_SINGLE_DOUBLE' },
        (result) => resolve(result)
      );
    });
  }

  _predictBigSmall() {
    return new Promise((resolve) => {
      this._postToWorker(
        { type: 'PREDICT_BIG_SMALL' },
        (result) => resolve(result)
      );
    });
  }

  _predictDoubleGroup() {
    return new Promise((resolve) => {
      this._postToWorker(
        { type: 'PREDICT_DOUBLE_GROUP' },
        (result) => resolve(result)
      );
    });
  }

  _predictKillGroup() {
    return new Promise((resolve) => {
      this._postToWorker(
        { type: 'PREDICT_KILL_GROUP' },
        (result) => resolve(result)
      );
    });
  }

  /**
   * Worker通信（修复竞态条件：校验消息ID + 超时清理）
   */
  _postToWorker(message, callback) {
    if (!this.worker) {
      if (callback) callback({ error: 'Worker未初始化' });
      return;
    }

    const messageId = `msg_${++this._workerMessageCounter}_${Date.now()}`;
    let settled = false;

    const handler = (event) => {
      // 仅处理匹配当前消息ID的响应
      if (event.data.id !== messageId) return;

      settled = true;
      if (callback) {
        callback(event.data.result || event.data);
      }
      this.worker.removeEventListener('message', handler);
      clearTimeout(timeoutId);
    };

    // 超时保护：10秒后自动清理监听器，防止内存泄漏
    const timeoutId = setTimeout(() => {
      if (!settled) {
        console.warn(`⚠️ Worker消息 ${messageId} 超时未响应`);
        this.worker.removeEventListener('message', handler);
        if (callback) callback({ error: '请求超时' });
      }
    }, 10000);

    this.worker.addEventListener('message', handler);
    this.worker.postMessage({ ...message, id: messageId });
  }

  /**
   * 检查某期开奖结果是否命中预测
   */
  checkPredictionHit(draw) {
    if (!this.lastPrediction) return null;

    const num = draw.number;
    const isOdd = num % 2 === 1;
    const isBig = num >= 14;

    // 判定该号码属于哪个组
    let drawGroup;
    if (isOdd && !isBig) drawGroup = 'ODD_SMALL';
    else if (isOdd && isBig) drawGroup = 'ODD_BIG';
    else if (!isOdd && !isBig) drawGroup = 'EVEN_SMALL';
    else drawGroup = 'EVEN_BIG';

    const result = {
      singleDouble: null,
      bigSmall: null,
      doubleGroup: null,
      anyHit: false
    };

    // 单双命中判定
    if (this.lastPrediction.singleDouble) {
      const predicted = this.lastPrediction.singleDouble;
      const actual = isOdd ? 'ODD' : 'EVEN';
      result.singleDouble = (predicted === actual);
    }

    // 大小命中判定
    if (this.lastPrediction.bigSmall) {
      const predicted = this.lastPrediction.bigSmall;
      const actual = isBig ? 'BIG' : 'SMALL';
      result.bigSmall = (predicted === actual);
    }

    // 双组命中判定
    if (this.lastPrediction.doubleGroupGroups) {
      result.doubleGroup = this.lastPrediction.doubleGroupGroups.includes(drawGroup);
    }

    result.anyHit = result.singleDouble || result.bigSmall || result.doubleGroup;

    return result;
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    const dbStats = await this.db.getStats();
    const uptime = (Date.now() - this.initializeTime) / 1000;

    this.stats = {
      uptime: `${uptime.toFixed(2)}秒`,
      dbStats,
      isOnline: this.isOnline,
      predictions: Object.keys(this.predictions),
      timestamp: Date.now()
    };

    return this.stats;
  }

  /**
   * 导出数据（备份）
   */
  async exportData() {
    try {
      const data = await this.db.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pc28-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return { code: 0, msg: '导出成功' };
    } catch (err) {
      return { code: 1, msg: err.message };
    }
  }

  /**
   * 导入数据（从备份文件恢复）
   */
  async importData(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const results = await this.db.importData(data);

      // 导入后刷新Worker数据
      const draws = await this.db.getRecentDraws(100);
      if (draws.length > 0) {
        await this._updateWorkerHistory(draws);
      }

      const total = Object.values(results).reduce((a, b) => a + b, 0);
      return { code: 0, msg: `导入成功，共 ${total} 条数据`, details: results };
    } catch (err) {
      return { code: 1, msg: err.message };
    }
  }

  /**
   * 自动刷新（存储intervalId以便清理）
   */
  _setupAutoRefresh() {
    // 清理旧的定时器（防止重复设置）
    if (this._refreshIntervalId) {
      clearInterval(this._refreshIntervalId);
    }

    // 每4.5分钟自动刷新一次
    this._refreshIntervalId = setInterval(() => {
      if (this.isOnline) {
        console.log('🔄 自动刷新数据...');
        this.fetchDrawData().catch(err => console.error(err));
      }
    }, 4.5 * 60 * 1000);
  }

  /**
   * 在线事件处理
   */
  _onOnline() {
    this.isOnline = true;
    console.log('✅ 网络连接已恢复');
    // 触发后台同步
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(registration => {
        registration.sync.register('sync-predictions');
      });
    }
  }

  /**
   * 离线事件处理
   */
  _onOffline() {
    this.isOnline = false;
    console.log('⚠️ 网络已断开连接，已切换到离线模式');
  }

  /**
   * 清空所有缓存
   */
  async clearAllData() {
    try {
      // 清空数据库
      await this.db.clearAll();
      // 清空Service Worker缓存
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
      // 重置预测状态
      this.predictions = {};
      this.lastPrediction = null;
      return { code: 0, msg: '所有数据已清空' };
    } catch (err) {
      return { code: 1, msg: err.message };
    }
  }

  /**
   * 销毁应用，清理资源
   */
  destroy() {
    if (this._refreshIntervalId) {
      clearInterval(this._refreshIntervalId);
      this._refreshIntervalId = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
