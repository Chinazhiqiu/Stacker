// ============================================================
// 第二部分：后台任务 - worker.js (Web Worker)
// 优化：缓存组合概率、回传消息ID解决竞态、修复missing计算
// ============================================================

/**
 * Web Worker - 后台计算线程
 * 处理CPU密集的预测算法，避免阻塞主线程
 */

// Worker自执行上下文
self.PC28_CONFIG = {
  TOTAL_NUMBERS: 28,
  RANGES: {
    SMALL: Array.from({length: 14}, (_, i) => i),
    BIG: Array.from({length: 14}, (_, i) => i + 14),
  },
  PARITY: {
    ODD: Array.from({length: 28}, (_, i) => i).filter(i => i % 2 === 1),
    EVEN: Array.from({length: 28}, (_, i) => i).filter(i => i % 2 === 0),
  }
};

class WorkerPredictionEngine {
  constructor(history = []) {
    this.history = history;
    this._comboProbCache = null;
  }

  // 特码预测
  predictLuckyNumber() {
    if (this.history.length < 5) return { error: '数据不足' };

    const freq = {};
    const missing = {};

    this.history.forEach(item => {
      freq[item.number] = (freq[item.number] || 0) + 1;
    });

    // 计算每个号码的遗漏期数（history[0]为最新）
    for (let i = 0; i < 28; i++) {
      let count = 0;
      let found = false;
      for (let j = 0; j < this.history.length; j++) {
        if (this.history[j].number === i) {
          found = true;
          break;
        }
        count++;
      }
      // 如果号码从未出现过，遗漏期数等于历史总长度
      missing[i] = found ? count : this.history.length;
    }

    const comboProb = this._calculateCombinationProbability();

    const scores = {};
    for (let i = 0; i < 28; i++) {
      const freqScore = (freq[i] || 0) / this.history.length;
      const missingScore = Math.min(missing[i] / this.history.length, 1);
      const comboScore = comboProb[i] || 0.1;
      scores[i] = freqScore * 0.4 + missingScore * 0.3 + comboScore * 0.3;
    }

    return Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([num, score]) => ({
        number: parseInt(num),
        score: (score * 100).toFixed(2),
        frequency: freq[num] || 0,
        missing: missing[num] || 0
      }));
  }

  // 单双预测
  predictSingleDouble() {
    if (this.history.length < 10) return { error: '数据不足' };

    const recent = this.history.slice(0, 20);
    const oddCount = recent.filter(item => item.number % 2 === 1).length;
    const evenCount = recent.length - oddCount;

    const oddRatio = oddCount / recent.length;
    let prediction = oddRatio > 0.5 ? 'ODD' : 'EVEN';
    let confidence = (Math.max(oddRatio, 1 - oddRatio) * 100).toFixed(2);

    // 连续性分析
    let maxConsecutiveOdd = 0, currentConsecutiveOdd = 0;
    recent.forEach(item => {
      if (item.number % 2 === 1) {
        currentConsecutiveOdd++;
        maxConsecutiveOdd = Math.max(maxConsecutiveOdd, currentConsecutiveOdd);
      } else {
        currentConsecutiveOdd = 0;
      }
    });

    if (maxConsecutiveOdd >= 5) {
      prediction = 'EVEN';
      confidence = 75;
    }

    return {
      prediction,
      confidence,
      oddRatio: (oddRatio * 100).toFixed(2),
      evenRatio: ((1 - oddRatio) * 100).toFixed(2),
      maxConsecutiveOdd
    };
  }

  // 大小预测
  predictBigSmall() {
    if (this.history.length < 10) return { error: '数据不足' };

    const recent = this.history.slice(0, 20);
    const bigCount = recent.filter(item => item.number >= 14).length;
    const smallCount = recent.length - bigCount;

    const bigRatio = bigCount / recent.length;
    let prediction = bigRatio > 0.5 ? 'BIG' : 'SMALL';
    let confidence = (Math.max(bigRatio, 1 - bigRatio) * 100).toFixed(2);

    return {
      prediction,
      confidence,
      bigRatio: (bigRatio * 100).toFixed(2),
      smallRatio: ((1 - bigRatio) * 100).toFixed(2)
    };
  }

  // 双组预测
  predictDoubleGroup() {
    if (this.history.length < 10) return { error: '数据不足' };

    const recent = this.history.slice(0, 30);
    const groups = {
      ODD_SMALL: 0,
      ODD_BIG: 0,
      EVEN_SMALL: 0,
      EVEN_BIG: 0
    };

    recent.forEach(item => {
      const num = item.number;
      if (num % 2 === 1) {
        if (num < 14) groups.ODD_SMALL++;
        else groups.ODD_BIG++;
      } else {
        if (num < 14) groups.EVEN_SMALL++;
        else groups.EVEN_BIG++;
      }
    });

    return Object.entries(groups)
      .sort((a, b) => b[1] - a[1])
      .map(([group, count]) => ({
        group,
        frequency: count,
        ratio: (count / recent.length * 100).toFixed(2)
      }));
  }

  // 杀组预测
  predictKillGroup() {
    if (this.history.length < 10) return { error: '数据不足' };

    const recent = this.history.slice(0, 30);
    const killScores = {
      KILL_ODD: 0,
      KILL_EVEN: 0,
      KILL_BIG: 0,
      KILL_SMALL: 0
    };

    let lastOdd = -1, lastEven = -1, lastBig = -1, lastSmall = -1;

    recent.forEach((item, idx) => {
      if (item.number % 2 === 1) lastOdd = idx;
      else lastEven = idx;
      if (item.number >= 14) lastBig = idx;
      else lastSmall = idx;
    });

    killScores.KILL_ODD = lastOdd === -1 ? recent.length : recent.length - lastOdd;
    killScores.KILL_EVEN = lastEven === -1 ? recent.length : recent.length - lastEven;
    killScores.KILL_BIG = lastBig === -1 ? recent.length : recent.length - lastBig;
    killScores.KILL_SMALL = lastSmall === -1 ? recent.length : recent.length - lastSmall;

    return Object.entries(killScores)
      .sort((a, b) => b[1] - a[1])
      .map(([group, missingPeriods]) => ({
        group,
        missingPeriods,
        confidence: Math.min(missingPeriods / recent.length * 100, 95).toFixed(2)
      }));
  }

  /**
   * 计算组合概率（结果固定，使用缓存避免重复计算）
   * 模拟三个 0-9 的数字相加后对 28 取模的概率分布
   */
  _calculateCombinationProbability() {
    if (this._comboProbCache) return this._comboProbCache;

    const combo = {};
    for (let i = 0; i < 28; i++) combo[i] = 0;

    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        for (let c = 0; c < 10; c++) {
          const result = (a + b + c) % 28;
          combo[result]++;
        }
      }
    }

    const total = Object.values(combo).reduce((a, b) => a + b, 0);
    const normalized = {};
    for (let key in combo) {
      normalized[key] = combo[key] / total;
    }

    this._comboProbCache = normalized;
    return normalized;
  }
}

// Worker消息处理
let engine = null;

self.onmessage = function(event) {
  const { type, payload, id } = event.data;

  try {
    if (type === 'INIT') {
      engine = new WorkerPredictionEngine(payload.history || []);
      self.postMessage({ type: 'INIT_SUCCESS', id });
    }
    else if (type === 'UPDATE_HISTORY') {
      if (engine) {
        engine.history = payload.history;
        self.postMessage({ type: 'UPDATE_SUCCESS', id });
      }
    }
    else if (type === 'PREDICT_LUCKY') {
      if (engine) {
        const result = engine.predictLuckyNumber();
        self.postMessage({ type: 'PREDICT_LUCKY_RESULT', result, id });
      }
    }
    else if (type === 'PREDICT_SINGLE_DOUBLE') {
      if (engine) {
        const result = engine.predictSingleDouble();
        self.postMessage({ type: 'PREDICT_SINGLE_DOUBLE_RESULT', result, id });
      }
    }
    else if (type === 'PREDICT_BIG_SMALL') {
      if (engine) {
        const result = engine.predictBigSmall();
        self.postMessage({ type: 'PREDICT_BIG_SMALL_RESULT', result, id });
      }
    }
    else if (type === 'PREDICT_DOUBLE_GROUP') {
      if (engine) {
        const result = engine.predictDoubleGroup();
        self.postMessage({ type: 'PREDICT_DOUBLE_GROUP_RESULT', result, id });
      }
    }
    else if (type === 'PREDICT_KILL_GROUP') {
      if (engine) {
        const result = engine.predictKillGroup();
        self.postMessage({ type: 'PREDICT_KILL_GROUP_RESULT', result, id });
      }
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', error: err.message, id });
  }
};
