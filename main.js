
function getServerUrl(path) {
  const baseUrl = window.SERVER_CONFIG?.baseUrl || "";
  if (!baseUrl) {
    return path;
  }
  const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBaseUrl}${path}`;
}
var TestEngine = class {
  constructor() {
    this.eventListeners = {};
    this.pc = null;
    this.dataChannel = null;
    this.packets = {};
    this.testRunning = false;
    this.serverRxCount = 0;
    this.isCleanedUp = false;
    this.activeTimeouts =  new Set();
    this.lossCheckInterval = null;
    this.pcId = null;
    this.connectionTimeoutId = null;
    this.wasDisconnected = false;
    this.reconnectAttempt = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimer = null;
    this.sendQueue = [];
    this.isSendingPaused = false;
    this.BUFFER_THRESHOLD = 16 * 1024 * 1024;
    this.BUFFER_LOW_WATERMARK = 8 * 1024 * 1024;
    this.sendingComplete = false;
    this.sendingCompleteTime = null;
    this.GRACE_PERIOD_MS = 3e3;
    this.stats = {
      sent: 0,
      received: 0,
      lost: 0,
      currentLoss: 0,
      c2sLost: 0,
      s2cLost: 0,
      c2sLossPercent: 0,
      s2cLossPercent: 0,
      jitter: 0,
      sentPPS: 0,
      receivedPPS: 0,
      outOfOrder: 0,
      outOfOrderPercent: 0,
      rtt: 0
    };
    this.ppsWindow = 1e3;
    this.lastPPSUpdate = 0;
    this.lastSentCount = 0;
    this.lastReceivedCount = 0;
    this.ppsHistory = {
      sent: [],
      received: []
    };
    this.SMA_WINDOW_SIZE = 5;
    this.lastReceivedSeq = -1;
    this.outOfOrderHistory = [];
    this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    this.PACKET_TIMEOUT = this.isMobile ? 5e3 : 2e3;
    this.smoothedRTT = null;
    this.rttVariance = 0;
    this.rttSampleCount = 0;
    this.lastRTT = null;
    this.BOOTSTRAP_PACKETS = 10;
    this.BOOTSTRAP_TIMEOUT = 5e3;
    this.MIN_TIMEOUT = 1e3;
    this.rttHistory = [];
    this.jitterHistory = [];
    this.displayRTT = 0;
    this.displayJitter = 0;
    this.autoIntervalEnabled = false;
    this.baseInterval = null;
    this.autoIntervalAdjusted = false;
    this.lastIntervalAdjustmentTime = 0;
    this.lossTrackingReady = false;
    this.baselineStats = {

      sent: 0,
      received: 0,
      serverRxCount: 0,
      priorC2SLost: 0,

      priorS2CLost: 0

    };
    this.calculationMode = "cumulative";
    this.realtimeWindowMs = 1e4;
    this.statsHistory = [];
  }

  getStunUrl() {
    if (window.STUN_CONFIG && window.STUN_CONFIG.enabled === false) {
      return null;
    }
    if (window.STUN_CONFIG && window.STUN_CONFIG.url) {
      return window.STUN_CONFIG.url;
    }
    const serverUrl = window.SERVER_CONFIG?.baseUrl || window.location.origin;
    try {
      const url = new URL(serverUrl);
      const stunUrl = `stun:${url.hostname}:3478`;
      return stunUrl;
    } catch (e) {
      return "stun:stun.l.google.com:19302";
    }
  }

  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }
  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    this.on(event, wrapper);
  }
  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter((cb) => cb !== callback);
    }
  }
  emit(event, data) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach((callback) => callback(data));
    }
  }

  trimHistory(history, maxLength) {
    if (history.length > maxLength) {
      history.shift();
    }
  }


  calculateSMA(history, round = true) {
    if (!history || history.length === 0) return 0;
    const sum = history.reduce((acc, val) => acc + val, 0);
    const average = sum / history.length;
    return round ? Math.round(average) : average;
  }
  calculatePPS() {
    if (!this.testRunning) {
      return;
    }
    if (this.testConfig && this.testConfig.count !== Infinity && this.stats.sent >= this.testConfig.count) {
      return;
    }
    if (this.sendingComplete && this.sendingCompleteTime) {
      const timeSinceComplete = Date.now() - this.sendingCompleteTime;
      if (timeSinceComplete > this.GRACE_PERIOD_MS) {
        return;
      }
    }
    const now = Date.now();
    const timeDelta = now - this.lastPPSUpdate;
    if (timeDelta >= this.ppsWindow) {
      const sentDelta = this.stats.sent - this.lastSentCount;
      const receivedDelta = this.stats.received - this.lastReceivedCount;
      const instantSentPPS = Math.round(sentDelta / timeDelta * 1e3);
      const instantReceivedPPS = Math.round(receivedDelta / timeDelta * 1e3);
      this.ppsHistory.sent.push(instantSentPPS);
      this.ppsHistory.received.push(instantReceivedPPS);
      this.trimHistory(this.ppsHistory.sent, this.SMA_WINDOW_SIZE);
      this.trimHistory(this.ppsHistory.received, this.SMA_WINDOW_SIZE);
      this.stats.sentPPS = this.calculateSMA(this.ppsHistory.sent);
      this.stats.receivedPPS = this.calculateSMA(this.ppsHistory.received);
      this.lastPPSUpdate = now;
      this.lastSentCount = this.stats.sent;
      this.lastReceivedCount = this.stats.received;
    }
  }
  calculateOutOfOrderStats() {
    if (!this.testRunning) {
      return;
    }
    if (this.testConfig && this.testConfig.count !== Infinity && this.stats.sent >= this.testConfig.count) {
      return;
    }
    if (this.sendingComplete && this.sendingCompleteTime) {
      const timeSinceComplete = Date.now() - this.sendingCompleteTime;
      if (timeSinceComplete > this.GRACE_PERIOD_MS) {
        return;
      }
    }
    if (this.calculationMode === "realtime") {
      if (this.statsHistory.length >= 2) {
        const oldest = this.statsHistory[0];
        const newest = this.statsHistory[this.statsHistory.length - 1];
        const windowReceived = newest.received - oldest.received;
        if (windowReceived > 0) {
          this.stats.outOfOrderPercent = this.stats.outOfOrder / windowReceived * 100;
        } else {
          this.stats.outOfOrderPercent = 0;
        }
      } else {
        this.stats.outOfOrderPercent = 0;
      }
    } else {
      if (this.stats.received > 0) {
        this.stats.outOfOrderPercent = this.stats.outOfOrder / this.stats.received * 100;
      } else {
        this.stats.outOfOrderPercent = 0;
      }
    }
  }
  calculateRealtimeLoss() {
    const now = Date.now();
    const currentSnapshot = {
      timestamp: now,
      sent: this.stats.sent - this.baselineStats.sent,
      received: this.stats.received - this.baselineStats.received,
      serverRxCount: this.serverRxCount - this.baselineStats.serverRxCount
    };
    this.statsHistory.push(currentSnapshot);
    const windowStart = now - this.realtimeWindowMs;
    this.statsHistory = this.statsHistory.filter((s) => s.timestamp >= windowStart);
    if (this.calculationMode === "realtime" && this.outOfOrderHistory && this.outOfOrderHistory.length > 0) {
      this.outOfOrderHistory = this.outOfOrderHistory.filter((o) => o.timestamp >= windowStart);
    }
    if (this.calculationMode === "realtime" && this.outOfOrderHistory) {
      this.stats.outOfOrder = this.outOfOrderHistory.length;
    }
    this.calculateOutOfOrderStats();
    if (this.autoIntervalEnabled && this.smoothedRTT) {
      const timeSinceLastAdjustment = now - (this.lastIntervalAdjustmentTime || 0);
      if (timeSinceLastAdjustment >= this.realtimeWindowMs) {
        this.recheckAndAdjustInterval();
      }
    }
    if (this.statsHistory.length < 2) {
      this.stats.c2sLossPercent = 0;
      this.stats.s2cLossPercent = 0;
      this.stats.currentLoss = 0;
      this.stats.windowSent = 0;
      this.stats.windowServerRx = 0;
      this.stats.windowLost = 0;
      this.stats.windowC2SLost = 0;
      this.stats.windowS2CLost = 0;
      return;
    }
    const oldest = this.statsHistory[0];
    const newest = this.statsHistory[this.statsHistory.length - 1];
    const deltaSent = newest.sent - oldest.sent;
    const deltaServerRx = newest.serverRxCount - oldest.serverRxCount;
    const deltaReceived = newest.received - oldest.received;
    const inFlightWindow = this.getAdaptiveTimeout();
    const currentTime = Date.now();
    let inFlight = 0;
    for (const seq in this.packets) {
      const packet = this.packets[seq];
      if (packet.sent < windowStart) {
        delete this.packets[seq];
        continue;
      }
      const packetAge = currentTime - packet.sent;
      if (packetAge >= inFlightWindow) continue;
      if (!packet.received) {
        inFlight++;
      }
    }
    const windowC2SLosses = Math.max(0, deltaSent - deltaServerRx - inFlight);
    const windowS2CLosses = Math.max(0, deltaServerRx - deltaReceived);
    let c2sLossRate = 0;
    let s2cLossRate = 0;
    if (deltaSent > 0) {
      c2sLossRate = windowC2SLosses / deltaSent;
      s2cLossRate = deltaServerRx > 0 ? windowS2CLosses / deltaServerRx : 0;
    }
    const totalSent = this.stats.sent - this.baselineStats.sent;
    const totalServerRx = this.serverRxCount - this.baselineStats.serverRxCount;
    const totalReceived = this.stats.received - this.baselineStats.received;
    const totalC2SLosses = Math.max(0, totalSent - totalServerRx - inFlight) + (this.baselineStats.priorC2SLost || 0);
    const totalS2CLosses = Math.max(0, totalServerRx - totalReceived) + (this.baselineStats.priorS2CLost || 0);
    this.stats.c2sLost = Math.max(this.stats.c2sLost, totalC2SLosses);
    this.stats.s2cLost = Math.max(this.stats.s2cLost, totalS2CLosses);
    this.stats.lost = this.stats.c2sLost + this.stats.s2cLost;
    this.stats.windowSent = deltaSent;
    this.stats.windowServerRx = deltaServerRx;
    this.stats.serverRxCount = this.serverRxCount;
    this.stats.windowLost = windowC2SLosses + windowS2CLosses;
    this.stats.windowC2SLost = windowC2SLosses;
    this.stats.windowS2CLost = windowS2CLosses;
    this.stats.c2sLossPercent = Math.min(100, c2sLossRate * 100);
    this.stats.s2cLossPercent = Math.min(100, s2cLossRate * 100);
    const rawCurrentLoss = deltaSent > 0 ? (windowC2SLosses + windowS2CLosses) / deltaSent * 100 : 0;
    this.stats.currentLoss = Math.min(100, rawCurrentLoss);
  }
  calculateLossStats() {
    if (!this.lossTrackingReady) {
      this.stats.c2sLost = 0;
      this.stats.s2cLost = 0;
      this.stats.lost = 0;
      this.stats.c2sLossPercent = 0;
      this.stats.s2cLossPercent = 0;
      this.stats.currentLoss = 0;
      return;
    }
    if (this.calculationMode === "realtime") {
      this.calculateRealtimeLoss();
      return;
    }
    const inFlightWindow = this.getAdaptiveTimeout();
    const currentTime = Date.now();
    let inFlight = 0;
    for (const seq in this.packets) {
      if (seq < this.baselineStats.sent) continue;
      const packet = this.packets[seq];
      const packetAge = currentTime - packet.sent;
      if (packetAge >= inFlightWindow) continue;
      if (!packet.received) {
        inFlight++;
      }
    }
    const deltaSent = this.stats.sent - this.baselineStats.sent;
    const deltaServerRx = this.serverRxCount - this.baselineStats.serverRxCount;
    const deltaReceived = this.stats.received - this.baselineStats.received;
    const currentC2SLosses = Math.max(0, deltaSent - deltaServerRx - inFlight);
    const currentS2CLosses = Math.max(0, deltaServerRx - deltaReceived);
    let c2sLossRate = 0;
    let s2cLossRate = 0;
    if (deltaSent > 0) {
      c2sLossRate = currentC2SLosses / deltaSent;
      s2cLossRate = deltaServerRx > 0 ? currentS2CLosses / deltaServerRx : 0;
    }
    const warmupC2SLost = Math.round(this.baselineStats.sent * c2sLossRate);
    const warmupS2CLost = Math.round(this.baselineStats.serverRxCount * s2cLossRate);
    this.stats.c2sLost = currentC2SLosses + warmupC2SLost;
    this.stats.s2cLost = currentS2CLosses + warmupS2CLost;
    this.stats.lost = this.stats.c2sLost + this.stats.s2cLost;
    this.stats.c2sLossPercent = Math.min(100, c2sLossRate * 100);
    this.stats.s2cLossPercent = Math.min(100, s2cLossRate * 100);
    const rawCurrentLoss = deltaSent > 0 ? (currentC2SLosses + currentS2CLosses) / deltaSent * 100 : 0;
    this.stats.currentLoss = Math.min(100, rawCurrentLoss);
    this.stats.serverRxCount = this.serverRxCount;
  }


  getAdaptiveTimeout() {
    if (this.rttSampleCount < this.BOOTSTRAP_PACKETS) {
      return this.BOOTSTRAP_TIMEOUT;
    }
    const adaptiveTimeout = this.smoothedRTT + 4 * this.rttVariance;
    return Math.max(this.MIN_TIMEOUT, Math.min(adaptiveTimeout, this.BOOTSTRAP_TIMEOUT));
  }


  updateRTT(measuredRTT) {
    this.rttSampleCount++;
    if (this.lastRTT !== null) {
      const jitterSample = Math.abs(measuredRTT - this.lastRTT);
      this.stats.jitter += (jitterSample - this.stats.jitter) / 16;
    }
    this.lastRTT = measuredRTT;
    if (this.smoothedRTT === null) {
      this.smoothedRTT = measuredRTT;
      this.rttVariance = measuredRTT / 2;
    } else {
      const alpha = 0.125;
      const beta = 0.25;
      const rttDiff = Math.abs(measuredRTT - this.smoothedRTT);
      this.rttVariance = (1 - beta) * this.rttVariance + beta * rttDiff;
      this.smoothedRTT = (1 - alpha) * this.smoothedRTT + alpha * measuredRTT;
    }
    this.rttHistory.push(this.smoothedRTT);
    this.trimHistory(this.rttHistory, this.SMA_WINDOW_SIZE);
    this.jitterHistory.push(this.stats.jitter);
    this.trimHistory(this.jitterHistory, this.SMA_WINDOW_SIZE);
    this.displayRTT = this.calculateSMA(this.rttHistory, false);
    this.displayJitter = this.calculateSMA(this.jitterHistory, false);
    if (this.rttSampleCount === this.BOOTSTRAP_PACKETS) {
      if (this.autoIntervalEnabled && !this.autoIntervalAdjusted) {
        this.adjustPacketInterval();
      } else {
        this.enableLossTracking();
      }
    } else if (this.rttSampleCount % 10 === 0) {
    }
  }

  enableLossTracking() {
    if (!this.lossTrackingReady) {
      this.lossTrackingReady = true;
      this.baselineStats = {
        sent: this.stats.sent,
        received: this.stats.received,
        serverRxCount: this.serverRxCount,
        priorC2SLost: 0,

        priorS2CLost: 0
      };
      this.statsHistory = [];
      this.outOfOrderHistory = [];
      this.emit("loss-tracking:ready");
    }
  }


  getOptimalInterval() {
    if (!this.smoothedRTT) return this.baseInterval;
    const MIN_INTERVAL = 15;
    const MAX_INTERVAL = 500;
    const RTT_MULTIPLIER = 0.5;
    const calculated = Math.round(this.smoothedRTT * RTT_MULTIPLIER);
    return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, calculated));
  }

  adjustPacketInterval() {
    if (this.autoIntervalAdjusted || !this.testRunning) return;
    const optimalInterval = this.getOptimalInterval();
    const currentInterval = this.baseInterval;
    const changePercent = Math.abs(optimalInterval - currentInterval) / currentInterval;
    if (changePercent < 0.2) {
      this.enableLossTracking();
      return;
    }
    this.autoIntervalAdjusted = true;
    this.lastIntervalAdjustmentTime = Date.now();
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
    }
    this.emit("interval:adjusted", {
      oldInterval: currentInterval,
      newInterval: optimalInterval,
      rtt: this.smoothedRTT
    });
    this.restartSendingWithInterval(optimalInterval);
    this.enableLossTracking();
  }

  recheckAndAdjustInterval() {
    if (!this.testRunning || !this.autoIntervalEnabled) return;
    const optimalInterval = this.getOptimalInterval();
    const currentInterval = this.baseInterval;
    const changePercent = Math.abs(optimalInterval - currentInterval) / currentInterval;
    if (changePercent < 0.2) {
      this.lastIntervalAdjustmentTime = Date.now();
      return;
    }
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
    }
    this.emit("interval:adjusted", {
      oldInterval: currentInterval,
      newInterval: optimalInterval,
      rtt: this.smoothedRTT
    });
    this.restartSendingWithInterval(optimalInterval);
    this.baselineStats = {
      sent: this.stats.sent,
      received: this.stats.received,
      serverRxCount: this.serverRxCount,
      priorC2SLost: this.stats.c2sLost || 0,
      priorS2CLost: this.stats.s2cLost || 0
    };
    this.statsHistory = [];
    this.outOfOrderHistory = [];
    this.lastIntervalAdjustmentTime = Date.now();
  }

  completeTest() {
    if (!this.testRunning || this.isCleanedUp) {
      return;
    }
    this.testRunning = false;
    this.calculateLossStats();
    this.stats.rtt = this.displayRTT || 0;
    this.stats.jitter = this.displayJitter || 0;
    const finalStats = {
      ...this.stats,
      interval: this.baseInterval || 0
    };
    this.emit("metrics:update", finalStats);
    this.emit("test:completed", finalStats);
    this.cleanup();
  }

  restartSendingWithInterval(newInterval) {
    if (!this.testRunning || !this.dataChannel) return;
    this.baseInterval = newInterval;
    this.sendInterval = setInterval(() => {
      if (!this.testRunning) {
        clearInterval(this.sendInterval);
        return;
      }
      if (this.testConfig.count !== Infinity && this.stats.sent >= this.testConfig.count) {
        clearInterval(this.sendInterval);
        return;
      }
      this.sendPacket(this.stats.sent);
    }, newInterval);
  }

  checkBackpressure() {
    if (!this.dataChannel) return false;
    const bufferedAmount = this.dataChannel.bufferedAmount;
    if (!this.isSendingPaused && bufferedAmount >= this.BUFFER_THRESHOLD) {
      this.isSendingPaused = true;
      return true;
    }
    if (this.isSendingPaused && bufferedAmount < this.BUFFER_LOW_WATERMARK) {
      this.isSendingPaused = false;
      this.processSendQueue();
    }
    return this.isSendingPaused;
  }

  processSendQueue() {
    while (this.sendQueue.length > 0 && !this.checkBackpressure()) {
      const seq = this.sendQueue.shift();
      this.sendPacketDirect(seq);
    }
  }

  sendPacket(seq) {
    if (this.checkBackpressure()) {
      this.sendQueue.push(seq);
      const MAX_QUEUE_SIZE = 1e3;
      if (this.sendQueue.length > MAX_QUEUE_SIZE) {
        this.sendQueue.shift();
      }
      return;
    }
    this.sendPacketDirect(seq);
  }

  sendPacketDirect(seq) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") return;
    const packetData = {
      seq,
      timestamp: Date.now()
    };
    if (this.packetPadding) {
      packetData.data = this.packetPadding;
    }
    const packet = JSON.stringify(packetData);
    try {
      const actualSendTime = Date.now();
      this.dataChannel.send(packet);
      this.stats.sent++;
      this.packets[seq] = {
        sent: actualSendTime,
        received: false,
        timedOut: false
      };
      if (this.testConfig.count !== Infinity && this.stats.sent >= this.testConfig.count) {
        if (!this.sendingComplete) {
          this.sendingComplete = true;
          this.sendingCompleteTime = Date.now();
          this.emit("test:sending-complete", { count: this.testConfig.count });
          const gracePeriodTimerId = setTimeout(() => {
            if (this.testRunning && !this.isCleanedUp) {
              this.completeTest();
            }
            this.activeTimeouts.delete(gracePeriodTimerId);
          }, this.GRACE_PERIOD_MS);
          this.activeTimeouts.add(gracePeriodTimerId);
        }
      }
      this.emit("metrics:update", {
        ...this.stats,
        rtt: this.displayRTT || 0,
        interval: this.baseInterval || 0,
        jitter: this.displayJitter || 0
      });
      const adaptiveTimeout = this.getAdaptiveTimeout();
      const timeoutTimerId = setTimeout(() => {
        if (!this.packets[seq]) return;
        if (!this.packets[seq].received && !this.packets[seq].timedOut) {
          this.packets[seq].timedOut = true;
        }
        if (this.testConfig.count === Infinity) {
          const deletionGraceMs = 5e3;
          const cleanupTimerId = setTimeout(() => {
            if (this.packets[seq] && !this.packets[seq].received) {
              delete this.packets[seq];
            }
            this.activeTimeouts.delete(cleanupTimerId);
          }, deletionGraceMs);
          this.activeTimeouts.add(cleanupTimerId);
        }
        this.activeTimeouts.delete(timeoutTimerId);
      }, adaptiveTimeout);
      this.activeTimeouts.add(timeoutTimerId);
    } catch (e) {
      if (e.message.includes("buffer")) {
      }
    }
  }
  async startTest(count, interval, direction = "both", duration = null, packetSize2 = 100, autoInterval = false, calculationMode = "cumulative", realtimeWindow = 10) {
    if (this.testRunning) {
      return;
    }
    this.cleanup();
    this.isCleanedUp = false;
    this.testRunning = true;
    this.direction = direction;
    this.testConfig = { count, interval, direction, duration, packetSize: packetSize2, calculationMode, realtimeWindow };
    this.baseInterval = interval;
    this.autoIntervalEnabled = autoInterval;
    this.autoIntervalAdjusted = false;
    this.calculationMode = calculationMode;
    this.realtimeWindowMs = realtimeWindow * 1e3;
    this.statsHistory = [];
    const baseSize = 30;
    const paddingSize = Math.max(0, packetSize2 - baseSize);
    this.packetPadding = paddingSize > 0 ? "x".repeat(paddingSize) : null;
    this.sendingComplete = false;
    this.sendingCompleteTime = null;
    this.packets = {};
    this.stats = {
      sent: 0,
      received: 0,
      lost: 0,
      currentLoss: 0,
      c2sLost: 0,
      s2cLost: 0,
      c2sLossPercent: 0,
      s2cLossPercent: 0,
      jitter: 0,
      sentPPS: 0,
      receivedPPS: 0,
      outOfOrder: 0,
      outOfOrderPercent: 0
    };
    this.serverRxCount = 0;
    this.lastPPSUpdate = Date.now();
    this.lastSentCount = 0;
    this.lastReceivedCount = 0;
    this.ppsHistory = {
      sent: [],
      received: []
    };
    this.lastReceivedSeq = -1;
    this.smoothedRTT = null;
    this.rttVariance = 0;
    this.rttSampleCount = 0;
    this.lastRTT = null;
    this.rttHistory = [];
    this.jitterHistory = [];
    this.displayRTT = 0;
    this.displayJitter = 0;
    this.testStartTime = Date.now();
    this.lossTrackingReady = false;
    this.emit("test:started", { count, interval, direction, duration, packetSize: packetSize2, calculationMode, realtimeWindow });
    this.emit("status", { message: "Preparing network test" });
    this.emit("metrics:update", {
      ...this.stats,
      rtt: this.smoothedRTT || 0,
      interval: this.baseInterval || 0
    });
    await new Promise((r) => setTimeout(r, 100));
    try {
      const CONNECTION_TIMEOUT_MS = 3e4;
      this.connectionTimeoutId = setTimeout(() => {
        if (this.testRunning && !this.isCleanedUp) {
          this.testRunning = false;
          this.emit("test:error", { message: "Connection timeout - please check your network and firewall settings" });
          this.cleanup();
        }
      }, CONNECTION_TIMEOUT_MS);
      await this.setupPeerConnection();
      this.setupDataChannel(count, interval, duration);
      this.emit("status", { message: "Gathering network paths" });
      this.restartSendingWithInterval(interval);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.emit("status", { message: "Exploring network paths" });
      if (this.pc.iceGatheringState !== "complete") {
        await new Promise((resolve) => {
          let resolved = false;
          const done = (reason) => {
            if (resolved) return;
            resolved = true;
            this.pc.removeEventListener("icegatheringstatechange", checkState);
            this.pc.removeEventListener("icecandidate", onCandidate);
            resolve();
          };
          const checkState = () => {
            if (this.pc.iceGatheringState === "complete") {
              done("complete");
            }
          };
          const onCandidate = (e) => {
            if (e.candidate && e.candidate.candidate.includes("srflx")) {
              done("early (srflx found)");
            }
          };
          this.pc.addEventListener("icegatheringstatechange", checkState);
          this.pc.addEventListener("icecandidate", onCandidate);
          setTimeout(() => {
            done("timeout");
          }, 2e3);
        });
      }
      this.emit("status", { message: "Establishing handshake" });
      const response = await fetch(getServerUrl("/webrtc/offer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: this.pc.localDescription })
      });
      if (!response.ok) {
        throw new Error(`Server rejected offer: ${response.status}`);
      }
      const answer = await response.json();
      this.pcId = answer.pc_id;
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer.sdp));
      this.emit("status", { message: "Handshake complete" });
      this.emit("status", { message: "Starting test" });
    } catch (e) {
      this.testRunning = false;
      this.emit("test:error", { message: `Failed to start: ${e.message}` });
      this.cleanup();
    }
  }
  async setupPeerConnection() {
    const stunUrl = this.getStunUrl();
    this.pc = new RTCPeerConnection({
      iceServers: stunUrl ? [{ urls: stunUrl }] : [],
      iceTransportPolicy: "all",
      iceCandidatePoolSize: 2
    });
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "failed" || state === "closed") {
        if (!this.isCleanedUp && this.testRunning) {
          if (this.calculationMode === "realtime" && this.testConfig.duration === Infinity) {
            this.handleDisconnectionForRealtimeMax();
          } else {
            this.testRunning = false;
            this.emit("test:error", { message: `Connection ${state}` });
            this.cleanup();
          }
        }
      } else if (state === "connected") {
        clearTimeout(this.connectionTimeoutId);
        this.connectionTimeoutId = null;
      }
    };
  }
  setupDataChannel(count, interval, duration) {
    this.dataChannel = this.pc.createDataChannel("udp-test", {
      ordered: false,
      maxRetransmits: 0
    });
    this.dataChannel.onopen = () => {
      const testDuration = duration !== null && duration !== void 0 ? duration : count === Infinity ? Infinity : count * interval / 1e3;
      if (this.lossCheckInterval) clearInterval(this.lossCheckInterval);
      this.lossCheckInterval = setInterval(() => {
        if (!this.testRunning) {
          if (this.lossCheckInterval) {
            clearInterval(this.lossCheckInterval);
            this.lossCheckInterval = null;
          }
          return;
        }
        this.calculateLossStats();
        this.calculatePPS();
        this.calculateOutOfOrderStats();
        this.emit("metrics:update", {
          ...this.stats,
          rtt: this.displayRTT || 0,
          interval: this.baseInterval || 0,
          jitter: this.displayJitter || 0
        });
      }, 200);
      if (testDuration !== Infinity && isFinite(testDuration)) {
        const fallbackTimeMs = testDuration * 1e3 + this.BOOTSTRAP_TIMEOUT;
        const fallbackTimerId = setTimeout(() => {
          if (this.testRunning && !this.isCleanedUp) {
            this.completeTest();
          }
          this.activeTimeouts.delete(fallbackTimerId);
        }, fallbackTimeMs);
        this.activeTimeouts.add(fallbackTimerId);
      }
    };
    this.dataChannel.onmessage = async (e) => {
      if (this.isCleanedUp) return;
      try {
        let textData;
        if (typeof e.data === "string") {
          textData = e.data;
        } else if (e.data instanceof ArrayBuffer) {
          textData = new TextDecoder().decode(e.data);
        } else if (e.data instanceof Blob) {
          textData = await e.data.text();
        }
        if (textData) {
          const data = JSON.parse(textData);
          if (data.s_rx !== void 0) {
            if (data.s_rx > this.serverRxCount) {
              const newConfirmations = data.s_rx - this.serverRxCount;
              this.serverRxCount = data.s_rx;
              if (this.testRunning) {
                this.emit("packet:sent", { count: newConfirmations, type: "c2s" });
              }
            }
          }
          if (this.packets[data.seq] !== void 0 && !this.packets[data.seq].received) {
            this.packets[data.seq].received = true;
            this.stats.received++;
            const receiveTime = Date.now();
            const sendTime = this.packets[data.seq].sent;
            const measuredRTT = receiveTime - sendTime;
            this.updateRTT(measuredRTT);
            if (data.seq < this.lastReceivedSeq) {
              const sequenceGap = this.lastReceivedSeq - data.seq;
              const MAX_OUT_OF_ORDER_GAP = 1e3;
              if (this.calculationMode === "realtime" && sequenceGap > MAX_OUT_OF_ORDER_GAP) {
              } else {
                this.stats.outOfOrder++;
                if (this.calculationMode === "realtime") {
                  this.outOfOrderHistory.push({
                    timestamp: Date.now(),
                    seq: data.seq
                  });
                }
              }
            } else {
              this.lastReceivedSeq = Math.max(this.lastReceivedSeq, data.seq);
            }
            if (this.testConfig.count === Infinity) {
              delete this.packets[data.seq];
            }
            if (this.testRunning) {
              this.emit("packet:received", { count: 1, type: "s2c" });
            }
          }
        }
      } catch (err) {
        if (!this.isCleanedUp) {
        }
      }
    };
    this.dataChannel.onclose = () => {
      if (!this.isCleanedUp && this.testRunning) {
        if (this.calculationMode === "realtime" && this.testConfig.duration === Infinity) {
          this.handleDisconnectionForRealtimeMax();
        } else {
          this.testRunning = false;
          this.emit("test:error", { message: "Data channel closed" });
          this.cleanup();
        }
      }
    };
    this.dataChannel.onerror = (e) => {
      if (!this.isCleanedUp && this.testRunning) {
        if (this.calculationMode === "realtime" && this.testConfig.duration === Infinity) {
          this.handleDisconnectionForRealtimeMax();
        } else {
          this.testRunning = false;
          this.emit("test:error", { message: `Data channel error: ${e.message}` });
          this.cleanup();
        }
      }
    };
  }


  handleDisconnectionForRealtimeMax() {
    if (this.wasDisconnected) {
      return;
    }
    this.wasDisconnected = true;
    this.reconnectAttempt = 0;
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
    const preservedSent = this.stats.sent;
    const preservedLost = this.stats.lost;
    this.emit("test:disconnected", {
      sent: preservedSent,
      lost: preservedLost
    });
    this.attemptReconnection();
  }

  attemptReconnection() {
    if (!this.wasDisconnected || !this.testRunning) {
      return;
    }
    this.reconnectAttempt++;
    if (this.reconnectAttempt > this.maxReconnectAttempts) {
      this.testRunning = false;
      this.emit("test:error", {
        message: `Connection lost. Failed to reconnect after ${this.maxReconnectAttempts} attempts.`
      });
      this.cleanup();
      return;
    }
    const delay = Math.min(1e3 * Math.pow(2, this.reconnectAttempt - 1), 3e4);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.resumeTestAfterReconnection();
      } catch (e) {
        this.attemptReconnection();
      }
    }, delay);
  }

  async resumeTestAfterReconnection() {
    if (!this.wasDisconnected) return;
    try {
      if (this.pc) {
        this.pc.close();
        this.pc = null;
      }
      if (this.dataChannel) {
        this.dataChannel.close();
        this.dataChannel = null;
      }
      this.pcId = null;
      this.candidateQueue = [];
      const preservedSent = this.stats.sent;
      const preservedLost = this.stats.lost;
      const preservedC2SLost = this.stats.c2sLost;
      const preservedS2CLost = this.stats.s2cLost;
      this.packets = {};
      this.serverRxCount = 0;
      this.stats.received = 0;
      this.stats.c2sLossPercent = 0;
      this.stats.s2cLossPercent = 0;
      this.stats.currentLoss = 0;
      this.stats.outOfOrder = 0;
      this.stats.outOfOrderPercent = 0;
      this.statsHistory = [];
      this.outOfOrderHistory = [];
      this.lastReceivedSeq = -1;
      this.lastPPSUpdate = Date.now();
      this.lastSentCount = preservedSent;
      this.lastReceivedCount = 0;
      this.ppsHistory.sent = [];
      this.ppsHistory.received = [];
      this.stats.sentPPS = 0;
      this.stats.receivedPPS = 0;
      this.stats.sent = preservedSent;
      this.stats.lost = preservedLost;
      this.baselineStats = {
        sent: preservedSent,
        received: 0,
        serverRxCount: 0,
        priorC2SLost: preservedC2SLost || 0,

        priorS2CLost: preservedS2CLost || 0

      };
      await this.setupPeerConnection();
      this.setupDataChannel(
        this.testConfig.count,
        this.testConfig.interval,
        this.testConfig.duration
      );
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (this.pc.iceGatheringState !== "complete") {
        await new Promise((resolve) => {
          const checkState = () => {
            if (this.pc.iceGatheringState === "complete") {
              this.pc.removeEventListener("icegatheringstatechange", checkState);
              resolve();
            }
          };
          this.pc.addEventListener("icegatheringstatechange", checkState);
          setTimeout(() => {
            this.pc.removeEventListener("icegatheringstatechange", checkState);
            resolve();
          }, 5e3);
        });
      }
      const response = await fetch(getServerUrl("/webrtc/offer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: this.pc.localDescription })
      });
      if (!response.ok) {
        throw new Error(`Server rejected offer: ${response.status}`);
      }
      const answer = await response.json();
      this.pcId = answer.pc_id;
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer.sdp));
      this.restartSendingWithInterval(this.baseInterval);
      this.wasDisconnected = false;
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.smoothedRTT !== null && this.rttSampleCount >= this.BOOTSTRAP_PACKETS) {
        this.lossTrackingReady = true;
        this.emit("loss-tracking:ready");
      }
      this.emit("test:reconnected", {
        sent: this.stats.sent,
        lost: this.stats.lost,
        c2sLost: this.stats.c2sLost,
        s2cLost: this.stats.s2cLost
      });
    } catch (e) {
      throw e;
    }
  }
  cleanup() {
    this.isCleanedUp = true;
    this.testRunning = false;
    this.wasDisconnected = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
    if (this.lossCheckInterval) {
      clearInterval(this.lossCheckInterval);
      this.lossCheckInterval = null;
    }
    if (this.connectionTimeoutId) {
      clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
    this.activeTimeouts.forEach((id) => clearTimeout(id));
    this.activeTimeouts.clear();
    this.packetPadding = null;
    this.testConfig = null;
    this.baseInterval = null;
    this.autoIntervalEnabled = false;
    this.autoIntervalAdjusted = false;
    this.calculationMode = "cumulative";
    this.realtimeWindowMs = 0;
    this.statsHistory = [];
    this.candidateQueue = [];
    this.pcId = null;
    this.sendQueue = [];
    this.isSendingPaused = false;
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
};


var LAYOUTS = {
  HORIZONTAL: {
    viewBox: "0 0 710 320",
    clientPos: { x: 60, y: 160 },
    serverPos: { x: 650, y: 160 },
    pathC2S: "M 100 200 L 610 200",
    pathS2C: "M 610 120 L 100 120",
    graphPos: { x: 130, y: 60 },
    graphSize: { w: 450, h: 200 },
    statsPos: { x: 130, y: 10 },
    statsSize: { w: 450, h: 40 },
    packetStartC2S: { x: 130, y: 200 },
    packetEndC2S: { x: 580, y: 200 },
    packetStartS2C: { x: 580, y: 120 },
    packetEndS2C: { x: 140, y: 120 },
    vertical: false
  },
  VERTICAL: {
    viewBox: "0 0 360 380",
    statsPos: { x: 30, y: 10 },
    statsSize: { w: 300, h: 40 },
    clientPos: { x: 180, y: 80 },
    graphPos: { x: 50, y: 150 },
    graphSize: { w: 280, h: 120 },
    serverPos: { x: 180, y: 330 },
    pathC2S: "M 140 100 L 140 310",
    pathS2C: "M 220 310 L 220 100",
    packetStartC2S: { x: 140, y: 150 },
    packetEndC2S: { x: 140, y: 270 },
    packetStartS2C: { x: 220, y: 270 },
    packetEndS2C: { x: 220, y: 150 },
    vertical: true
  }
};
var CONFIG = {
  packetSpeed: 2,
  graphUpdateInterval: 200,

  maxGraphPoints: 40,
  yScale: 1,
  smaWindowSize: 25

};
var Particle = class {
  constructor(x, y, color) {
    if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
      this.invalid = true;
      return;
    }
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 4;
    this.vy = (Math.random() - 0.5) * 4;
    this.life = 1;
    this.decay = 0.05 + Math.random() * 0.05;
    this.color = color;
    this.invalid = false;
    const root2 = document.getElementById("openpacketloss-root");
    const particlesGroup = root2.querySelector("#particles-group");
    this.el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.el.setAttribute("r", 2 + Math.random() * 2);
    this.el.setAttribute("fill", color);
    this.updatePosition();
    particlesGroup.appendChild(this.el);
  }
  updatePosition() {
    this.el.setAttribute("cx", this.x);
    this.el.setAttribute("cy", this.y);
    this.el.setAttribute("opacity", this.life);
  }
  update() {
    if (this.invalid) {
      return true;
    }
    this.x += this.vx;
    this.y += this.vy;
    this.life -= this.decay;
    this.updatePosition();
    if (this.life <= 0) {
      this.el.remove();
      return false;
    }
    return true;
  }
};
var Packet = class {
  constructor(type, visualEngine2) {
    this.type = type;
    this.progress = 0;
    this.lost = false;
    this.dead = false;
    this.success = false;
    this.opacity = 1;
    this.visualEngine = visualEngine2;
    this.layout = visualEngine2.currentLayout;
    this.creationTime = Date.now();
    this.updateCoordinates();
    this.color = type === "c2s" ? "var(--client-color)" : "var(--server-color)";
    if (type === "c2s") {
      this.label = visualEngine2.c2sCount % 2 === 0 ? "0" : "1";
      visualEngine2.c2sCount++;
    } else {
      this.label = visualEngine2.s2cCount % 2 === 0 ? "0" : "1";
      visualEngine2.s2cCount++;
    }
    const root2 = document.getElementById("openpacketloss-root");
    const groupC2S = root2.querySelector("#packets-c2s");
    const groupS2C = root2.querySelector("#packets-s2c");
    this.group = type === "c2s" ? groupC2S : groupS2C;
    this.el = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.updatePosition();
    const size = 24;
    const offset = -size / 2;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", offset);
    rect.setAttribute("y", offset);
    rect.setAttribute("width", size);
    rect.setAttribute("height", size);
    rect.setAttribute("rx", 4);
    rect.setAttribute("fill", this.color);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "packet-text");
    text.setAttribute("font-size", "12");
    text.textContent = this.label;
    this.el.appendChild(rect);
    this.el.appendChild(text);
    this.group.appendChild(this.el);
    this.willLose = false;
    this.lossPoint = 0.3 + Math.random() * 0.5;
  }
  updateCoordinates() {
    const layout = this.visualEngine.currentLayout || LAYOUTS.HORIZONTAL;
    this.layout = layout;
    if (this.type === "c2s") {
      this.start = layout.packetStartC2S || { x: 100, y: 200 };
      this.end = layout.packetEndC2S || { x: 610, y: 200 };
    } else {
      this.start = layout.packetStartS2C || { x: 610, y: 120 };
      this.end = layout.packetEndS2C || { x: 100, y: 120 };
    }
  }
  updatePosition() {
    if (!this.start || !this.end) this.updateCoordinates();
    const cx = this.start.x + (this.end.x - this.start.x) * this.progress;
    const cy = this.start.y + (this.end.y - this.start.y) * this.progress;
    const safeCx = isNaN(cx) ? this.start.x : cx;
    const safeCy = isNaN(cy) ? this.start.y : cy;
    this.el.setAttribute("transform", `translate(${safeCx.toFixed(1)}, ${safeCy.toFixed(1)})`);
    this.el.setAttribute("opacity", this.opacity);
  }
  forceLoss() {
    this.willLose = true;
    this.lossPoint = this.progress + 0.02;
  }
  update() {
    if (this.dead) {
      this.el.remove();
      return false;
    }
    if (Date.now() - this.creationTime > 2e4) {
      this.dead = true;
      this.el.remove();
      return false;
    }
    this.updateCoordinates();
    if (this.lost) {
      if (!this.lossTimestamp) this.lossTimestamp = Date.now();
      if (Date.now() - this.lossTimestamp > 1e3) {
        this.dead = true;
      }
      return true;
    }
    const dx = this.end.x - this.start.x;
    const dy = this.end.y - this.start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = CONFIG.packetSpeed / (dist || 1);
    this.progress += step;
    if (this.progress > 1) {
      this.progress = 1;
    }
    this.updatePosition();
    if (this.willLose && this.progress >= this.lossPoint) {
      this.lost = true;
      this.lossTimestamp = Date.now();
      this.el.classList.add("packet-lost");
      const cross = document.createElementNS("http://www.w3.org/2000/svg", "text");
      cross.setAttribute("x", 0);
      cross.setAttribute("y", 6);
      cross.setAttribute("text-anchor", "middle");
      cross.setAttribute("fill", "#ffffff");
      cross.setAttribute("font-size", "28");
      cross.setAttribute("font-weight", "bold");
      cross.textContent = "\xD7";
      this.el.appendChild(cross);
      const transform = this.el.getAttribute("transform");
      const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        const cx = parseFloat(match[1]);
        const cy = parseFloat(match[2]);
        if (!isNaN(cx) && !isNaN(cy) && isFinite(cx) && isFinite(cy)) {
          this.spawnParticles(cx, cy, "#ef4444", 8);
        }
      } else {
        const cx = this.start.x + (this.end.x - this.start.x) * this.progress;
        const cy = this.start.y + (this.end.y - this.start.y) * this.progress;
        if (!isNaN(cx) && !isNaN(cy) && isFinite(cx) && isFinite(cy)) {
          this.spawnParticles(cx, cy, "#ef4444", 8);
        }
      }
      setTimeout(() => {
        this.dead = true;
      }, 500);
      return true;
    }
    if (this.progress >= 1) {
      if (!this.success) {
        this.success = true;
        this.spawnParticles(this.end.x, this.end.y, "#10b981");
        this.el.classList.add("packet-success");
        const textEl = this.el.querySelector("text");
        if (textEl) textEl.textContent = "\u2713";
        setTimeout(() => {
          this.dead = true;
        }, 300);
      }
      return true;
    }
    return true;
  }
  spawnParticles(x, y, color, count = 8) {
    if (this.visualEngine.particles.length > 50) return;
    for (let i = 0; i < count; i++) {
      const particle = new Particle(x, y, color);
      if (!particle.invalid) {
        this.visualEngine.particles.push(particle);
      }
    }
  }
};
var VisualizationEngine = class {
  constructor() {
    this.running = false;
    this.testCompleted = false;
    this.tabVisible = true;
    this.packets = [];
    this.particles = [];
    this.graphData = new Array(CONFIG.maxGraphPoints).fill(0);
    this.currentLayout = LAYOUTS.HORIZONTAL;
    this.yAxisMax = 5;
    this.yAxisMin = -5;
    this.c2sCount = 0;
    this.s2cCount = 0;
    this.c2sBucketCount = 0;
    this.s2cBucketCount = 0;
    this.bucketStartTime = 0;
    this.visualSchedule = [];
    this.lastGraphUpdate = 0;
    this.animationInterval = null;
    this.lossHistory = [];
    this.c2sLossHistory = [];
    this.s2cLossHistory = [];
    this.completeGraphHistory = [];
    this.metricsBuffer = [];
    this.metricsBufferProcessedCount = 0;
    this.MAX_METRICS_BUFFER_SIZE = 1e3;
    this.lastC2SLossTotal = 0;
    this.lastS2CLossTotal = 0;
    this.c2sLossAccumulator = 0;
    this.s2cLossAccumulator = 0;
    this.realPacketsPerVisual = 1;
    this.stats = {
      sent: 0,
      received: 0,
      lost: 0,
      currentLoss: 0,
      c2sLost: 0,
      s2cLost: 0,
      c2sLossPercent: 0,
      s2cLossPercent: 0,
      sentPPS: 0,
      receivedPPS: 0,
      outOfOrder: 0,
      outOfOrderPercent: 0
    };
    this.currentRTT = 0;
    this.currentInterval = 0;
    this.currentJitter = 0;
    this.showNetworkMetrics = false;
    this.lossTrackingReady = false;
    this.calculationMode = "cumulative";
    this.realtimeWindowMs = 1e4;
    this.root = document.getElementById("openpacketloss-root");
    this.dom = {
      svg: this.root.querySelector("#main-svg"),
      clientGroup: this.root.querySelector("#client-group"),
      serverGroup: this.root.querySelector("#server-group"),
      pathC2S: this.root.querySelector("#path-c2s"),
      pathS2C: this.root.querySelector("#path-s2c"),
      graphGroup: this.root.querySelector("#graph-group"),
      graphBg: this.root.querySelector("#graph-bg"),
      gridLines: this.root.querySelector("#grid-lines"),
      axisLabels: this.root.querySelector("#axis-labels"),
      graphLine: this.root.querySelector("#graph-line"),
      graphArea: this.root.querySelector("#graph-area"),
      watermarkText: this.root.querySelector("#watermark-text"),
      statsGroup: this.root.querySelector("#stats-group")
    };
    this.initializeDOM();
    this.setupEventListeners();
  }
  setShowNetworkMetrics(show) {
    this.showNetworkMetrics = show;
    this.updateNetworkLabels();
  }
  initializeDOM() {
    this.applyLayout(LAYOUTS.HORIZONTAL);
    this.updateLayout();
  }
  setupEventListeners() {
    window.matchMedia("(orientation: portrait)").addEventListener("change", () => this.updateLayout());
    window.addEventListener("resize", () => this.updateLayout());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.tabVisible = false;
        this.stopAnimationLoop();
      } else {
        this.tabVisible = true;
        if (this.running) {
          const now = Date.now();
          this.bucketStartTime = now;
          this.lastGraphUpdate = now;
          this.visualSchedule = [];
          this.c2sBucketCount = 0;
          this.s2cBucketCount = 0;
          if (!this.testCompleted) {
            if (this.calculationMode === "realtime") {
              this.metricsBuffer = [];
              this.metricsBufferProcessedCount = 0;
              this.lossHistory = [];
              this.c2sLossHistory = [];
              this.s2cLossHistory = [];
            } else {
              if (this.metricsBuffer.length > this.metricsBufferProcessedCount) {
                this.backfillGraphFromBuffer();
                this.metricsBuffer = [];
                this.metricsBufferProcessedCount = 0;
              }
            }
          } else {
            this.lossHistory = [];
            this.c2sLossHistory = [];
            this.s2cLossHistory = [];
          }
          this.startAnimationLoop();
        }
      }
    });
  }
  onTestStarted(data) {
    this.running = true;
    this.testCompleted = false;
    this.direction = data.direction || "both";
    this.calculationMode = data.calculationMode || "cumulative";
    this.realtimeWindowMs = (data.realtimeWindow || 10) * 1e3;
    this.packets.forEach((p) => p.el.remove());
    this.packets = [];
    this.particles.forEach((p) => p.el.remove());
    this.particles = [];
    this.graphData.fill(0);
    this.c2sCount = 0;
    this.s2cCount = 0;
    this.c2sBucketCount = 0;
    this.s2cBucketCount = 0;
    this.bucketStartTime = 0;
    this.visualSchedule = [];
    this.lossHistory = [];
    this.c2sLossHistory = [];
    this.s2cLossHistory = [];
    this.completeGraphHistory = [];
    this.metricsBuffer = [];
    this.metricsBufferProcessedCount = 0;
    this.lossTrackingReady = false;
    this.lastC2SLossTotal = 0;
    this.lastS2CLossTotal = 0;
    this.c2sLossAccumulator = 0;
    this.s2cLossAccumulator = 0;
    const interval = data.interval || 20;
    this.updateVisualScaling(interval);
    this.startAnimationLoop();
  }
  onLossTrackingReady() {
    this.lossTrackingReady = true;
  }
  updateVisualScaling(interval) {
    const newScaling = Math.max(1, Math.ceil(300 / interval));
    if (newScaling !== this.realPacketsPerVisual) {
      this.realPacketsPerVisual = newScaling;
    }
  }

  onDisconnected(data) {
    this.metricsBuffer = [];
    this.metricsBufferProcessedCount = 0;
    this.lossHistory = [];
    this.c2sLossHistory = [];
    this.s2cLossHistory = [];
    this.lossTrackingReady = false;
  }

  onReconnected(data) {
    this.lastC2SLossTotal = data.c2sLost || 0;
    this.lastS2CLossTotal = data.s2cLost || 0;
    this.c2sLossAccumulator = 0;
    this.s2cLossAccumulator = 0;
  }
  onTestCompleted(data) {
    this.stats = data;
    this.testCompleted = true;
    this.updateStatsUI();
    const waitForPacketsToFinish = setInterval(() => {
      if (this.packets.length === 0 && this.particles.length === 0) {
        clearInterval(waitForPacketsToFinish);
        this.running = false;
        this.stopAnimationLoop();
      }
    }, 100);
  }
  onPacketSent(data) {
    if (this.running && data.type === "c2s" && (this.direction === "both" || this.direction === "c2s")) {
      this.c2sBucketCount += data.count;
    }
  }
  onPacketReceived(data) {
    if (this.running && data.type === "s2c" && (this.direction === "both" || this.direction === "s2c")) {
      this.s2cBucketCount += data.count;
    }
  }
  onMetricsUpdate(stats) {
    this.stats = stats;
    const now = Date.now();
    if (stats.rtt !== void 0) this.currentRTT = stats.rtt;
    if (stats.interval !== void 0 && stats.interval !== this.currentInterval) {
      this.currentInterval = stats.interval;
      this.updateVisualScaling(this.currentInterval);
    }
    if (stats.jitter !== void 0) this.currentJitter = stats.jitter;
    if (this.running && !this.testCompleted) {
      if (this.metricsBuffer.length >= this.MAX_METRICS_BUFFER_SIZE) {
        const removeCount = Math.floor(this.MAX_METRICS_BUFFER_SIZE * 0.2);
        this.metricsBuffer.splice(0, removeCount);
        this.metricsBufferProcessedCount = Math.max(0, this.metricsBufferProcessedCount - removeCount);
      }
      this.metricsBuffer.push({
        timestamp: now,
        stats: { ...stats }

      });
      if (this.calculationMode === "realtime" && this.metricsBuffer.length > 100) {
        const windowStart = now - this.realtimeWindowMs * 2;
        const oldLength = this.metricsBuffer.length;
        this.metricsBuffer = this.metricsBuffer.filter((m) => m.timestamp >= windowStart);
        const removed = oldLength - this.metricsBuffer.length;
        if (removed > 0) {
          this.metricsBufferProcessedCount = Math.max(0, this.metricsBufferProcessedCount - removed);
        }
      }
    }
    if (this.running && !this.testCompleted && now - this.lastGraphUpdate >= CONFIG.graphUpdateInterval) {
      const rawLoss = this.getDirectionalLoss(stats);
      const newVal = rawLoss < 0.01 ? 0 : rawLoss;
      this.completeGraphHistory.push({
        timestamp: now,
        loss: newVal,
        c2sLoss: stats.c2sLossPercent || 0,
        s2cLoss: stats.s2cLossPercent || 0
      });
      this.lossHistory.push(rawLoss);
      if (this.lossHistory.length > CONFIG.smaWindowSize) {
        this.lossHistory.shift();
      }
      const c2sLoss = stats.sent >= 20 ? stats.c2sLossPercent || 0 : 0;
      this.c2sLossHistory.push(c2sLoss);
      if (this.c2sLossHistory.length > CONFIG.smaWindowSize) {
        this.c2sLossHistory.shift();
      }
      const s2cLoss = stats.sent >= 20 ? stats.s2cLossPercent || 0 : 0;
      this.s2cLossHistory.push(s2cLoss);
      if (this.s2cLossHistory.length > CONFIG.smaWindowSize) {
        this.s2cLossHistory.shift();
      }
      let graphVal;
      if (this.calculationMode === "realtime") {
        const realtimeWindow = Math.min(3, this.lossHistory.length);
        if (realtimeWindow > 0) {
          const recentSamples = this.lossHistory.slice(-realtimeWindow);
          const sum = recentSamples.reduce((acc, val) => acc + val, 0);
          const avg = sum / recentSamples.length;
          graphVal = avg < 0.01 ? 0 : avg;
        } else {
          graphVal = newVal;
        }
      } else {
        graphVal = this.calculateSMA();
      }
      this.graphData.shift();
      this.graphData.push(graphVal);
      this.lastGraphUpdate = now;
      this.metricsBufferProcessedCount = this.metricsBuffer.length;
      if (this.tabVisible) {
        this.updateGraphVisuals();
      }
    }
    if (!this.testCompleted && this.tabVisible) {
      this.updateStatsUI();
      this.updateNetworkLabels();
    }
    if (this.running && this.lossTrackingReady) {
      const newC2SLoss = (stats.c2sLost || 0) - this.lastC2SLossTotal;
      if (newC2SLoss > 0) {
        this.c2sLossAccumulator += newC2SLoss;
        while (this.c2sLossAccumulator >= this.realPacketsPerVisual) {
          if (this.triggerVisualLoss("c2s")) {
            this.c2sLossAccumulator -= this.realPacketsPerVisual;
          } else {
            break;
          }
        }
        this.lastC2SLossTotal = stats.c2sLost;
      }
      const newS2CLoss = (stats.s2cLost || 0) - this.lastS2CLossTotal;
      if (newS2CLoss > 0) {
        this.s2cLossAccumulator += newS2CLoss;
        while (this.s2cLossAccumulator >= this.realPacketsPerVisual) {
          if (this.triggerVisualLoss("s2c")) {
            this.s2cLossAccumulator -= this.realPacketsPerVisual;
          } else {
            break;
          }
        }
        this.lastS2CLossTotal = stats.s2cLost;
      }
    }
  }
  triggerVisualLoss(type) {
    const travelingPackets = this.packets.filter(
      (p) => p.type === type && !p.lost && !p.success && !p.dead && p.progress > 0.1 && p.progress < 0.9 && !p.willLose

    );
    if (travelingPackets.length > 0) {
      const randomIndex = Math.floor(Math.random() * travelingPackets.length);
      const packetToFail = travelingPackets[randomIndex];
      if (packetToFail && !packetToFail.willLose) {
        packetToFail.forceLoss();
        return true;
      }
    }
    return false;
  }
  startAnimationLoop() {
    if (this.animationInterval) return;
    this.animationInterval = setInterval(() => this.loop(), 16);
  }
  stopAnimationLoop() {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = null;
    }
  }
  loop() {
    try {
      const now = Date.now();
      if (this.bucketStartTime === 0) this.bucketStartTime = now;
      if (now - this.bucketStartTime >= 500) {
        if (!this.running) {
          this.c2sBucketCount = 0;
          this.s2cBucketCount = 0;
          this.bucketStartTime = now;
        } else {
          const c2sCount = Math.min(this.c2sBucketCount, 1);
          if (c2sCount > 0 && (this.direction === "both" || this.direction === "c2s")) {
            const interval = 500 / c2sCount;
            for (let i = 0; i < c2sCount; i++) {
              this.visualSchedule.push({
                time: now + i * interval,
                type: "c2s"
              });
            }
          }
          const s2cCount = Math.min(this.s2cBucketCount, 1);
          if (s2cCount > 0 && (this.direction === "both" || this.direction === "s2c")) {
            const interval = 500 / s2cCount;
            for (let i = 0; i < s2cCount; i++) {
              this.visualSchedule.push({
                time: now + i * interval,
                type: "s2c"
              });
            }
          }
          this.c2sBucketCount = 0;
          this.s2cBucketCount = 0;
          this.bucketStartTime = now;
        }
      }
      this.visualSchedule.sort((a, b) => a.time - b.time);
      while (this.visualSchedule.length > 0 && this.visualSchedule[0].time <= now) {
        const item = this.visualSchedule.shift();
        const packet = new Packet(item.type, this);
        this.packets.push(packet);
      }
      this.packets = this.packets.filter((p) => p.update());
      this.particles = this.particles.filter((p) => p.update());
    } catch (e) {
    }
  }

  getDirectionalLoss(stats) {
    if (this.direction === "c2s") {
      return stats.sent >= 20 ? stats.c2sLossPercent || 0 : 0;
    } else if (this.direction === "s2c") {
      return stats.sent >= 20 ? stats.s2cLossPercent || 0 : 0;
    } else {
      if (this.calculationMode === "realtime") {
        return stats.sent >= 20 ? stats.currentLoss || 0 : 0;
      } else {
        return stats.sent >= 20 ? stats.lost / stats.sent * 100 : 0;
      }
    }
  }
  calculateSMA() {
    let smaLoss = 0;
    if (this.direction === "c2s") {
      const sum = this.c2sLossHistory.reduce((acc, val) => acc + val, 0);
      smaLoss = this.c2sLossHistory.length > 0 ? sum / this.c2sLossHistory.length : 0;
    } else if (this.direction === "s2c") {
      const sum = this.s2cLossHistory.reduce((acc, val) => acc + val, 0);
      smaLoss = this.s2cLossHistory.length > 0 ? sum / this.s2cLossHistory.length : 0;
    } else {
      const sum = this.lossHistory.reduce((acc, val) => acc + val, 0);
      smaLoss = this.lossHistory.length > 0 ? sum / this.lossHistory.length : 0;
    }
    return smaLoss < 0.01 ? 0 : smaLoss;
  }

  renderStats(layout) {
    this.dom.statsGroup.innerHTML = "";
    const boxWidth = (layout.statsSize.w - 20) / 3;
    const boxHeight = layout.statsSize.h;
    const startX = layout.statsPos.x;
    const startY = layout.statsPos.y;
    const statsConfig = [
      { id: "sent", label: "Sent", color: "#4fc3f7", bg: "rgba(79, 195, 247, 0.1)" },
      { id: "loss", label: "Total Loss", color: "#64ffda", bg: "rgba(100, 255, 218, 0.1)" },
      { id: "lost", label: "Lost", color: "#ff5252", bg: "rgba(255, 82, 82, 0.1)" }
    ];
    statsConfig.forEach((stat, index) => {
      const x = startX + index * (boxWidth + 10);
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", startY);
      rect.setAttribute("width", boxWidth);
      rect.setAttribute("height", boxHeight);
      rect.setAttribute("rx", 6);
      rect.setAttribute("ry", 6);
      rect.setAttribute("class", "stat-box-rect");
      rect.setAttribute("fill", stat.bg);
      rect.setAttribute("stroke", stat.color);
      const valText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      valText.setAttribute("x", x + boxWidth / 2);
      valText.setAttribute("y", startY + boxHeight / 2 - 5);
      valText.setAttribute("class", "stat-value-text");
      valText.setAttribute("fill", stat.color);
      valText.setAttribute("id", `svg-stat-${stat.id}`);
      valText.textContent = stat.id === "loss" ? "0%" : "0";
      const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      labelText.setAttribute("x", x + boxWidth / 2);
      labelText.setAttribute("y", startY + boxHeight / 2 + 12);
      labelText.setAttribute("class", "stat-label-text");
      labelText.textContent = stat.label;
      g.appendChild(rect);
      g.appendChild(valText);
      g.appendChild(labelText);
      this.dom.statsGroup.appendChild(g);
    });
  }
  updateStatsUI() {
    const elSent = document.getElementById("svg-stat-sent");
    const elLoss = document.getElementById("svg-stat-loss");
    const elLost = document.getElementById("svg-stat-lost");
    let smoothedC2SLoss, smoothedS2CLoss;
    const c2sLoss = this.stats.sent >= 20 ? this.stats.c2sLossPercent || 0 : 0;
    const s2cLoss = this.stats.sent >= 20 ? this.stats.s2cLossPercent || 0 : 0;
    if (this.testCompleted) {
      smoothedC2SLoss = c2sLoss;
      smoothedS2CLoss = s2cLoss;
    } else if (this.calculationMode === "realtime") {
      const realtimeWindow = Math.min(3, this.c2sLossHistory.length);
      if (realtimeWindow > 0) {
        const c2sRecent = this.c2sLossHistory.slice(-realtimeWindow);
        const c2sSum = c2sRecent.reduce((acc, val) => acc + val, 0);
        smoothedC2SLoss = c2sSum / c2sRecent.length;
        const s2cRecent = this.s2cLossHistory.slice(-realtimeWindow);
        const s2cSum = s2cRecent.reduce((acc, val) => acc + val, 0);
        smoothedS2CLoss = s2cSum / s2cRecent.length;
      } else {
        smoothedC2SLoss = c2sLoss;
        smoothedS2CLoss = s2cLoss;
      }
    } else {
      const c2sSum = this.c2sLossHistory.reduce((acc, val) => acc + val, 0);
      smoothedC2SLoss = this.c2sLossHistory.length > 0 ? c2sSum / this.c2sLossHistory.length : 0;
      const s2cSum = this.s2cLossHistory.reduce((acc, val) => acc + val, 0);
      smoothedS2CLoss = this.s2cLossHistory.length > 0 ? s2cSum / this.s2cLossHistory.length : 0;
    }
    if (this.direction === "c2s") {
      this.stats.currentLoss = smoothedC2SLoss;
    } else if (this.direction === "s2c") {
      this.stats.currentLoss = smoothedS2CLoss;
    }
    if (elSent) {
      if (this.direction === "s2c") {
        elSent.textContent = this.calculationMode === "realtime" ? this.stats.windowServerRx ?? 0 : this.stats.serverRxCount ?? 0;
      } else {
        elSent.textContent = this.calculationMode === "realtime" ? this.stats.windowSent ?? 0 : this.stats.sent;
      }
    }
    const isNegligibleLoss = !this.testCompleted && this.stats.currentLoss < 0.01;
    if (elLost) {
      if (this.direction === "c2s") {
        elLost.textContent = this.calculationMode === "realtime" ? this.stats.windowC2SLost ?? 0 : this.stats.c2sLost ?? 0;
      } else if (this.direction === "s2c") {
        elLost.textContent = this.calculationMode === "realtime" ? this.stats.windowS2CLost ?? 0 : this.stats.s2cLost ?? 0;
      } else {
        elLost.textContent = this.calculationMode === "realtime" ? this.stats.windowLost ?? 0 : this.stats.lost;
      }
    }
    if (elLoss) {
      const displayLoss = isNegligibleLoss ? 0 : this.stats.currentLoss;
      const val = Number(displayLoss.toFixed(1));
      elLoss.textContent = val + "%";
      if (displayLoss > 20) {
        elLoss.setAttribute("fill", "var(--loss-color)");
      } else {
        elLoss.setAttribute("fill", "var(--text-color)");
      }
    }
    this.updateDirectionalLossLabels(smoothedC2SLoss, smoothedS2CLoss);
  }
  updateNetworkLabels() {
    let rttLabel = document.getElementById("rtt-label");
    if (!rttLabel) {
      rttLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      rttLabel.setAttribute("id", "rtt-label");
      rttLabel.setAttribute("class", "network-metric-label");
      rttLabel.setAttribute("text-anchor", "start");
      rttLabel.setAttribute("font-size", "10");
      rttLabel.setAttribute("font-weight", "600");
      rttLabel.setAttribute("fill", "#9ca3af");
      rttLabel.setAttribute("opacity", "0.6");
      this.dom.graphGroup.appendChild(rttLabel);
    }
    if (this.running && this.showNetworkMetrics) {
      rttLabel.setAttribute("visibility", "visible");
      rttLabel.setAttribute("x", 5);
      rttLabel.setAttribute("y", 10);
      const rttValue = this.currentRTT > 0 ? Math.round(this.currentRTT) : 0;
      rttLabel.textContent = `RTT: ${rttValue}ms`;
    } else {
      rttLabel.setAttribute("visibility", "hidden");
    }
    let intervalLabel = document.getElementById("interval-label");
    if (!intervalLabel) {
      intervalLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      intervalLabel.setAttribute("id", "interval-label");
      intervalLabel.setAttribute("class", "network-metric-label");
      intervalLabel.setAttribute("text-anchor", "start");
      intervalLabel.setAttribute("font-size", "10");
      intervalLabel.setAttribute("font-weight", "600");
      intervalLabel.setAttribute("fill", "#9ca3af");
      intervalLabel.setAttribute("opacity", "0.6");
      this.dom.graphGroup.appendChild(intervalLabel);
    }
    if (this.running && this.showNetworkMetrics) {
      intervalLabel.setAttribute("visibility", "visible");
      intervalLabel.setAttribute("x", 5);
      intervalLabel.setAttribute("y", 36);
      const intervalValue = this.currentInterval > 0 ? Math.round(this.currentInterval * 10) / 10 : 0;
      intervalLabel.textContent = `Interval: ${intervalValue}ms`;
    } else {
      intervalLabel.setAttribute("visibility", "hidden");
    }
    let jitterLabel = document.getElementById("jitter-label");
    if (!jitterLabel) {
      jitterLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      jitterLabel.setAttribute("id", "jitter-label");
      jitterLabel.setAttribute("class", "network-metric-label");
      jitterLabel.setAttribute("text-anchor", "start");
      jitterLabel.setAttribute("font-size", "10");
      jitterLabel.setAttribute("font-weight", "600");
      jitterLabel.setAttribute("fill", "#9ca3af");
      jitterLabel.setAttribute("opacity", "0.6");
      this.dom.graphGroup.appendChild(jitterLabel);
    }
    if (this.running && this.showNetworkMetrics) {
      jitterLabel.setAttribute("visibility", "visible");
      jitterLabel.setAttribute("x", 5);
      jitterLabel.setAttribute("y", 23);
      const jitterValue = this.currentJitter > 0 ? this.currentJitter.toFixed(1) : "0.0";
      jitterLabel.textContent = `Jitter: ${jitterValue}ms`;
    } else {
      jitterLabel.setAttribute("visibility", "hidden");
    }
    let sentPPSLabel = document.getElementById("sent-pps-label");
    if (!sentPPSLabel) {
      sentPPSLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      sentPPSLabel.setAttribute("id", "sent-pps-label");
      sentPPSLabel.setAttribute("class", "network-metric-label");
      sentPPSLabel.setAttribute("text-anchor", "end");
      sentPPSLabel.setAttribute("font-size", "10");
      sentPPSLabel.setAttribute("font-weight", "600");
      sentPPSLabel.setAttribute("fill", "#9ca3af");
      sentPPSLabel.setAttribute("opacity", "0.6");
      this.dom.graphGroup.appendChild(sentPPSLabel);
    }
    if (this.running && this.showNetworkMetrics) {
      sentPPSLabel.setAttribute("visibility", "visible");
      const w = this.currentLayout?.graphSize?.w || 450;
      sentPPSLabel.setAttribute("x", w - 5);
      sentPPSLabel.setAttribute("y", 10);
      const sentPPSValue = this.stats.sentPPS || 0;
      sentPPSLabel.textContent = `Sent: ${sentPPSValue} pps`;
    } else {
      sentPPSLabel.setAttribute("visibility", "hidden");
    }
    let receivedPPSLabel = document.getElementById("received-pps-label");
    if (!receivedPPSLabel) {
      receivedPPSLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      receivedPPSLabel.setAttribute("id", "received-pps-label");
      receivedPPSLabel.setAttribute("class", "network-metric-label");
      receivedPPSLabel.setAttribute("text-anchor", "end");
      receivedPPSLabel.setAttribute("font-size", "10");
      receivedPPSLabel.setAttribute("font-weight", "600");
      receivedPPSLabel.setAttribute("fill", "#9ca3af");
      receivedPPSLabel.setAttribute("opacity", "0.6");
      this.dom.graphGroup.appendChild(receivedPPSLabel);
    }
    if (this.running && this.showNetworkMetrics) {
      receivedPPSLabel.setAttribute("visibility", "visible");
      const w = this.currentLayout?.graphSize?.w || 450;
      receivedPPSLabel.setAttribute("x", w - 5);
      receivedPPSLabel.setAttribute("y", 23);
      const receivedPPSValue = this.stats.receivedPPS || 0;
      receivedPPSLabel.textContent = `Received: ${receivedPPSValue} pps`;
    } else {
      receivedPPSLabel.setAttribute("visibility", "hidden");
    }
    let outOfOrderLabel = document.getElementById("out-of-order-label");
    if (!outOfOrderLabel) {
      outOfOrderLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      outOfOrderLabel.setAttribute("id", "out-of-order-label");
      outOfOrderLabel.setAttribute("class", "network-metric-label");
      outOfOrderLabel.setAttribute("text-anchor", "end");
      outOfOrderLabel.setAttribute("font-size", "10");
      outOfOrderLabel.setAttribute("font-weight", "600");
      outOfOrderLabel.setAttribute("fill", "#9ca3af");
      outOfOrderLabel.setAttribute("opacity", "0.6");
      this.dom.graphGroup.appendChild(outOfOrderLabel);
    }
    if (this.running && this.showNetworkMetrics) {
      outOfOrderLabel.setAttribute("visibility", "visible");
      const w = this.currentLayout?.graphSize?.w || 450;
      outOfOrderLabel.setAttribute("x", w - 5);
      outOfOrderLabel.setAttribute("y", 36);
      const outOfOrderValue = this.stats.outOfOrderPercent || 0;
      if (outOfOrderValue >= 5) {
        outOfOrderLabel.setAttribute("fill", "#ef4444");
        outOfOrderLabel.setAttribute("opacity", "0.9");
      } else if (outOfOrderValue >= 1) {
        outOfOrderLabel.setAttribute("fill", "#f59e0b");
        outOfOrderLabel.setAttribute("opacity", "0.8");
      } else {
        outOfOrderLabel.setAttribute("fill", "#9ca3af");
        outOfOrderLabel.setAttribute("opacity", "0.6");
      }
      outOfOrderLabel.textContent = `Out-of-Order: ${outOfOrderValue.toFixed(1)}%`;
    } else {
      outOfOrderLabel.setAttribute("visibility", "hidden");
    }
  }
  updateDirectionalLossLabels(c2sLoss, s2cLoss) {
    let c2sLabel = document.getElementById("c2s-loss-label");
    if (!c2sLabel) {
      c2sLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      c2sLabel.setAttribute("id", "c2s-loss-label");
      c2sLabel.setAttribute("class", "directional-loss-label");
      c2sLabel.setAttribute("text-anchor", "middle");
      c2sLabel.setAttribute("font-size", "11");
      c2sLabel.setAttribute("font-weight", "bold");
      c2sLabel.setAttribute("fill", "#4fc3f7");
      this.dom.clientGroup.appendChild(c2sLabel);
    }
    if (this.direction === "both") {
      c2sLabel.setAttribute("visibility", "visible");
      const c2sY = this.currentLayout.vertical ? 65 : -40;
      c2sLabel.setAttribute("y", c2sY);
      c2sLabel.setAttribute("x", 0);
      const displayC2S = !this.testCompleted && c2sLoss < 0.01 ? 0 : c2sLoss;
      c2sLabel.textContent = `\u2191 ${displayC2S.toFixed(1)}%`;
      c2sLabel.setAttribute("fill", displayC2S > 20 ? "#ff5252" : "#4fc3f7");
    } else {
      c2sLabel.setAttribute("visibility", "hidden");
    }
    let s2cLabel = document.getElementById("s2c-loss-label");
    if (!s2cLabel) {
      s2cLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      s2cLabel.setAttribute("id", "s2c-loss-label");
      s2cLabel.setAttribute("class", "directional-loss-label");
      s2cLabel.setAttribute("text-anchor", "middle");
      s2cLabel.setAttribute("font-size", "11");
      s2cLabel.setAttribute("font-weight", "bold");
      s2cLabel.setAttribute("fill", "#64ffda");
      this.dom.serverGroup.appendChild(s2cLabel);
    }
    if (this.direction === "both") {
      s2cLabel.setAttribute("visibility", "visible");
      const s2cY = this.currentLayout.vertical ? -35 : -40;
      s2cLabel.setAttribute("y", s2cY);
      s2cLabel.setAttribute("x", 0);
      const displayS2C = !this.testCompleted && s2cLoss < 0.01 ? 0 : s2cLoss;
      s2cLabel.textContent = `\u2193 ${displayS2C.toFixed(1)}%`;
      s2cLabel.setAttribute("fill", displayS2C > 20 ? "#ff5252" : "#64ffda");
    } else {
      s2cLabel.setAttribute("visibility", "hidden");
    }
  }
  updateGraphVisuals(fillGraph = false) {
    this.updateYAxisMax();
    const w = this.currentLayout?.graphSize?.w || 450;
    const h = this.currentLayout?.graphSize?.h || 200;
    let actualData = this.graphData;
    let stepX;
    if (fillGraph) {
      let firstNonZeroIndex = -1;
      for (let i = 0; i < this.graphData.length; i++) {
        if (this.graphData[i] > 0) {
          firstNonZeroIndex = i;
          break;
        }
      }
      if (firstNonZeroIndex > 0 && firstNonZeroIndex < this.graphData.length - 5) {
        const startIndex = Math.max(0, firstNonZeroIndex - 1);
        actualData = this.graphData.slice(startIndex);
        const pointCount = Math.max(2, actualData.length - 1);
        stepX = w / pointCount;
      } else {
        stepX = w / (CONFIG.maxGraphPoints - 1);
      }
    } else {
      stepX = w / (CONFIG.maxGraphPoints - 1);
    }
    let d = "M ";
    actualData.forEach((val, i) => {
      const x = i * stepX;
      const y = h - (val - this.yAxisMin) * CONFIG.yScale;
      d += `${x.toFixed(1)} ${y.toFixed(1)} `;
      if (i < actualData.length - 1) d += "L ";
    });
    this.dom.graphLine.setAttribute("d", d);
    const lastX = (actualData.length - 1) * stepX;
    const areaD = d + `L ${lastX.toFixed(1)} ${h} L 0 ${h} Z`;
    this.dom.graphArea.setAttribute("d", areaD);
  }
  updateYAxisMax() {
    const maxLoss = Math.max(...this.graphData);
    const minLoss = Math.min(...this.graphData);
    let newMax = 5;
    let newMin = -5;
    if (maxLoss > 2) {
      newMin = 0;
      if (maxLoss <= 5) {
        newMax = 10;
      } else if (maxLoss <= 10) {
        newMax = 15;
      } else if (maxLoss <= 15) {
        newMax = 20;
      } else if (maxLoss <= 20) {
        newMax = 30;
      } else if (maxLoss <= 30) {
        newMax = 40;
      } else if (maxLoss <= 50) {
        newMax = 60;
      } else {
        newMax = 100;
      }
    }
    if (newMax !== this.yAxisMax || newMin !== this.yAxisMin) {
      this.yAxisMax = newMax;
      this.yAxisMin = newMin;
      this.rebuildGrid();
    }
  }
  updateLayout() {
    const isPortrait = window.matchMedia("(orientation: portrait)").matches;
    const newLayout = isPortrait ? LAYOUTS.VERTICAL : LAYOUTS.HORIZONTAL;
    if (this.currentLayout !== newLayout) {
      this.currentLayout = newLayout;
      this.applyLayout(newLayout);
    }
  }
  applyLayout(layout) {
    this.dom.svg.setAttribute("viewBox", layout.viewBox);
    this.dom.clientGroup.setAttribute("transform", `translate(${layout.clientPos.x}, ${layout.clientPos.y})`);
    this.dom.serverGroup.setAttribute("transform", `translate(${layout.serverPos.x}, ${layout.serverPos.y})`);
    this.dom.pathC2S.setAttribute("d", layout.pathC2S);
    this.dom.pathS2C.setAttribute("d", layout.pathS2C);
    this.dom.graphGroup.setAttribute("transform", `translate(${layout.graphPos.x}, ${layout.graphPos.y})`);
    this.dom.graphBg.setAttribute("width", layout.graphSize.w);
    this.dom.graphBg.setAttribute("height", layout.graphSize.h);
    this.renderStats(layout);
    this.updateStatsUI();
    this.updateNetworkLabels();
    this.rebuildGrid();
    if (this.dom.watermarkText) {
      this.dom.watermarkText.setAttribute("x", layout.graphSize.w / 2);
      const divisor = layout.vertical ? 1.45 : 1.6;
      this.dom.watermarkText.setAttribute("y", layout.graphSize.h / divisor);
    }
  }
  rebuildGrid() {
    this.dom.gridLines.innerHTML = "";
    this.dom.axisLabels.innerHTML = "";
    const w = this.currentLayout?.graphSize?.w || 450;
    const h = this.currentLayout?.graphSize?.h || 200;
    const yMax = this.yAxisMax;
    const yMin = this.yAxisMin;
    const yRange = yMax - yMin;
    for (let i = 0; i <= 4; i++) {
      const y = h - i * (h / 4);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", 0);
      line.setAttribute("y1", y);
      line.setAttribute("x2", w);
      line.setAttribute("y2", y);
      line.setAttribute("class", "grid-line");
      this.dom.gridLines.appendChild(line);
      if (!this.currentLayout.vertical || i % 2 === 0) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", -10);
        label.setAttribute("y", y);
        label.setAttribute("text-anchor", "end");
        label.setAttribute("class", "axis-label");
        label.setAttribute("dominant-baseline", "middle");
        const labelValue = yMin + i * (yRange / 4);
        label.textContent = labelValue.toFixed(0) + "%";
        this.dom.axisLabels.appendChild(label);
      }
    }
    CONFIG.yScale = h / yRange;
  }
  reconstructGraphFromHistory() {
    if (this.completeGraphHistory.length === 0) {
      return;
    }
    this.updateGraphVisuals(true);
  }
  backfillGraphFromBuffer() {
    const unprocessedCount = this.metricsBuffer.length - this.metricsBufferProcessedCount;
    if (unprocessedCount <= 0) {
      return;
    }
    let startIndex = this.metricsBufferProcessedCount;
    if (this.calculationMode === "realtime") {
      const now = Date.now();
      const windowStart = now - this.realtimeWindowMs;
      for (let i = this.metricsBufferProcessedCount; i < this.metricsBuffer.length; i++) {
        if (this.metricsBuffer[i].timestamp >= windowStart) {
          startIndex = i;
          break;
        }
      }
      const discardedCount = startIndex - this.metricsBufferProcessedCount;
      if (discardedCount > 0) {
        this.lossHistory = [];
        this.c2sLossHistory = [];
        this.s2cLossHistory = [];
      } else {
      }
    }
    let processedCount = 0;
    let totalRawLoss = 0;
    for (let index = startIndex; index < this.metricsBuffer.length; index++) {
      const item = this.metricsBuffer[index];
      const stats = item.stats;
      const timestamp = item.timestamp;
      const rawLoss = this.getDirectionalLoss(stats);
      totalRawLoss += rawLoss;
      processedCount++;
      this.lossHistory.push(rawLoss);
      if (this.lossHistory.length > CONFIG.smaWindowSize) {
        this.lossHistory.shift();
      }
      const c2sLoss = stats.sent >= 20 ? stats.c2sLossPercent || 0 : 0;
      this.c2sLossHistory.push(c2sLoss);
      if (this.c2sLossHistory.length > CONFIG.smaWindowSize) {
        this.c2sLossHistory.shift();
      }
      const s2cLoss = stats.sent >= 20 ? stats.s2cLossPercent || 0 : 0;
      this.s2cLossHistory.push(s2cLoss);
      if (this.s2cLossHistory.length > CONFIG.smaWindowSize) {
        this.s2cLossHistory.shift();
      }
      const smoothedVal = this.calculateSMA();
      this.completeGraphHistory.push({
        timestamp,
        loss: smoothedVal,
        c2sLoss: stats.c2sLossPercent || 0,
        s2cLoss: stats.s2cLossPercent || 0
      });
      this.graphData.shift();
      this.graphData.push(smoothedVal);
    }
    const avgRawLoss = processedCount > 0 ? totalRawLoss / processedCount : 0;
    this.metricsBufferProcessedCount = this.metricsBuffer.length;
    this.updateGraphVisuals();
    this.updateStatsUI();
    const lastGraphValue = this.graphData[this.graphData.length - 1];
    const smaValue = this.calculateSMA();
    const lastFewGraphValues = this.graphData.slice(-5).map((v) => v.toFixed(1)).join(", ");
  }
};


var InputValidator = class {
  static ERROR_MESSAGES = {
    OUT_OF_RANGE: "Value must be between {min} and {max}",
    POSITIVE_REQUIRED: "Value must be greater than 0",
    PLATFORM_LIMIT: "This value exceeds the platform limit of {max}",
    NAN_ERROR: "Invalid input - not a number"
  };
  
  static _error(key, params = {}) {
    let error = this.ERROR_MESSAGES[key];
    for (const [k, v] of Object.entries(params)) {
      error = error.replace(`{${k}}`, v);
    }
    return { valid: false, value: null, error };
  }
  
  static validatePacketInterval(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return this._error("NAN_ERROR");
    if (num <= 0) return this._error("POSITIVE_REQUIRED");
    const MAX_INTERVAL = 1e4;
    if (num > MAX_INTERVAL) {
      return this._error("OUT_OF_RANGE", { min: 0, max: MAX_INTERVAL });
    }
    return { valid: true, value: num, error: null };
  }
  
  static validatePacketSize(value, platform = "web") {
    const num = parseInt(value);
    if (isNaN(num)) return this._error("NAN_ERROR");
    const MIN_SIZE = 50;
    const maxSize = platform === "web" ? 1500 : 9e3;
    if (num < MIN_SIZE || num > maxSize) {
      return this._error("OUT_OF_RANGE", { min: MIN_SIZE, max: maxSize });
    }
    return { valid: true, value: num, error: null };
  }
  
  static validatePacketCount(value, platform = "web") {
    if (value === Infinity || value === "Infinity") {
      if (platform === "web") {
        return this._error("PLATFORM_LIMIT", { max: "6000" });
      }
      return { valid: true, value: Infinity, error: null };
    }
    const num = parseInt(value);
    if (isNaN(num)) return this._error("NAN_ERROR");
    if (num <= 0) return this._error("POSITIVE_REQUIRED");
    const maxCount = platform === "web" ? 6e3 : Infinity;
    if (maxCount !== Infinity && num > maxCount) {
      return this._error("PLATFORM_LIMIT", { max: maxCount });
    }
    return { valid: true, value: num, error: null };
  }
  
  static validateDuration(value, platform = "web") {
    if (value === Infinity || value === "Infinity") {
      if (platform === "web") {
        return this._error("PLATFORM_LIMIT", { max: "300 seconds" });
      }
      return { valid: true, value: Infinity, error: null };
    }
    const num = parseInt(value);
    if (isNaN(num)) return this._error("NAN_ERROR");
    const MIN_DURATION = 1;
    const maxDuration = platform === "web" ? 300 : 3600;
    if (num < MIN_DURATION || num > maxDuration) {
      return this._error("OUT_OF_RANGE", { min: MIN_DURATION, max: maxDuration });
    }
    return { valid: true, value: num, error: null };
  }
  
  static validateRealtimeWindow(value) {
    const num = parseInt(value);
    if (isNaN(num)) return this._error("NAN_ERROR");
    const MIN_WINDOW = 5;
    const MAX_WINDOW = 60;
    if (num < MIN_WINDOW || num > MAX_WINDOW) {
      return this._error("OUT_OF_RANGE", { min: MIN_WINDOW, max: MAX_WINDOW });
    }
    return { valid: true, value: num, error: null };
  }
  
  static validateSettings(settings, platform = "web") {
    const errors = [];
    const validations = {
      packetInterval: (v) => this.validatePacketInterval(v),
      packetSize: (v) => this.validatePacketSize(v, platform),
      packetCount: (v) => this.validatePacketCount(v, platform),
      duration: (v) => this.validateDuration(v, platform),
      realtimeWindow: (v) => this.validateRealtimeWindow(v)
    };
    for (const [key, validator] of Object.entries(validations)) {
      if (settings[key] !== void 0) {
        const result = validator(settings[key]);
        if (!result.valid) {
          errors.push(`${key}: ${result.error}`);
        }
      }
    }
    return {
      valid: errors.length === 0,
      errors
    };
  }
};


var ErrorHandler = class {
  static ERROR_CATALOG = {
    "CONNECTION_FAILED": {
      title: "Connection Failed",
      message: "Unable to establish WebRTC connection.",
      technicalHelp: "WebRTC requires UDP traffic. Common ports: 3478 (STUN), 49152-65535 (media)"
    },
    "CONNECTION_TIMEOUT": {
      title: "Connection Timeout",
      message: "Connection attempt timed out.",
      technicalHelp: "ICE negotiation took longer than 30 seconds"
    },
    "DATA_CHANNEL_ERROR": {
      title: "Data Transfer Error",
      message: "Lost connection during test.",
      technicalHelp: "DataChannel failed due to network instability"
    }
  };
  
  static showError(errorType, technicalDetails = null, onRetry = null) {
    const error = this.ERROR_CATALOG[errorType] || {
      title: "Error",
      message: errorType,
      causes: [],
      solutions: ["Try again", "Contact support"],
      technicalHelp: ""
    };
    const root2 = document.getElementById("openpacketloss-root");
    const existing = root2.querySelector("#error-detail-modal");
    if (existing) existing.remove();
    const modal = document.createElement("div");
    modal.id = "error-detail-modal";
    modal.className = "error-modal-overlay";
    const content = document.createElement("div");
    content.className = "error-modal-compact";
    content.innerHTML = `
            <div class="error-modal-header">
                <span class="error-icon">\u26A0\uFE0F</span>
                <h2>${error.title}</h2>
            </div>
            
            <p class="error-modal-message">${error.message}</p>
            
            ${error.technicalHelp || technicalDetails ? `
                <div class="error-modal-technical-hint">
                    ${error.technicalHelp || ""}
                    ${technicalDetails ? `<div class="error-detail">${technicalDetails}</div>` : ""}
                </div>
            ` : ""}
            
            <div class="error-modal-actions">
                ${onRetry ? '<button class="error-btn error-btn-retry">Retry</button>' : ""}
                <a href="https://openpacketloss.com/faq.php#${errorType}" target="_blank" class="error-btn error-btn-learn">Learn More</a>
            </div>
        `;
    modal.appendChild(content);
    root2.appendChild(modal);
    if (onRetry) {
      const retryBtn = content.querySelector(".error-btn-retry");
      retryBtn.addEventListener("click", () => {
        window.location.reload();
      });
    }
  }
  
  static mapErrorMessage(message) {
    const msg = message.toLowerCase();
    if (msg.includes("timeout")) return "CONNECTION_TIMEOUT";
    if (msg.includes("datachannel") || msg.includes("data channel")) return "DATA_CHANNEL_ERROR";
    return "CONNECTION_FAILED";
  }
  
  static showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `error-toast error-toast-${type}`;
    toast.textContent = message;
    const root2 = document.getElementById("openpacketloss-root");
    root2.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("fade-out");
      setTimeout(() => toast.remove(), 300);
    }, 3e3);
  }
};


var testEngine = new TestEngine();
var visualEngine = new VisualizationEngine();
testEngine.on("test:started", (data) => visualEngine.onTestStarted(data));
testEngine.on("status", (data) => updateStatusText(data.message));
testEngine.once("packet:sent", () => hideConnectingState());
testEngine.once("packet:received", () => hideConnectingState());
testEngine.on("test:completed", (data) => visualEngine.onTestCompleted(data));
testEngine.on("packet:sent", (data) => visualEngine.onPacketSent(data));
testEngine.on("packet:received", (data) => visualEngine.onPacketReceived(data));
testEngine.on("metrics:update", (data) => visualEngine.onMetricsUpdate(data));
testEngine.on("test:error", (data) => {
  const errorType = ErrorHandler.mapErrorMessage(data.message);
  ErrorHandler.showError(errorType, data.message, () => {
    startTest();
  });
});
testEngine.on("loss-tracking:ready", () => visualEngine.onLossTrackingReady());
testEngine.on("test:disconnected", (data) => visualEngine.onDisconnected(data));
testEngine.on("test:reconnected", (data) => visualEngine.onReconnected(data));
testEngine.on("interval:adjusted", (data) => {
});
var SETTINGS_VERSION = 3;
var testSettings = {
  version: SETTINGS_VERSION,
  preset: "default",
  duration: 30,
  direction: "both",
  packetInterval: 15.625,
  packetCount: 1920,
  packetSize: 100,

  autoInterval: true,

  showNetworkMetrics: false,

  calculationMode: null,

  realtimeWindow: 10

};
var isTestFinished = false;
var lastTestStats = null;
var PRESETS = {
  quick: {
    duration: window.TEST_CONFIG?.presets?.quick?.duration ?? 10,
    count: window.TEST_CONFIG?.presets?.quick?.packetCount ?? 200,
    interval: window.TEST_CONFIG?.presets?.quick?.interval ?? 50,
    label: "QUICK"
  },
  default: {
    duration: window.TEST_CONFIG?.presets?.default?.duration ?? 30,
    count: window.TEST_CONFIG?.presets?.default?.packetCount ?? 1920,
    interval: window.TEST_CONFIG?.presets?.default?.interval ?? 15.625,
    label: "DEFAULT"
  },
  stress: {
    duration: window.TEST_CONFIG?.presets?.max?.duration ?? 300,
    count: window.TEST_CONFIG?.presets?.max?.packetCount ?? 6e3,
    interval: window.TEST_CONFIG?.presets?.max?.interval ?? 50,
    label: "MAX"
  }
};
var root = document.getElementById("openpacketloss-root");
var startOverlay = root.querySelector("#start-overlay");
var settingsModal = root.querySelector("#settings-modal");
var btnTest = root.querySelector("#btn-test");
var btnSettings = root.querySelector("#btn-settings");
var closeSettings = root.querySelector("#close-settings");
var startTestFromModal = root.querySelector("#start-test-from-modal");
var themeBtn = root.querySelector("#theme-btn");
var durationSlider = root.querySelector("#duration-slider");
var durationValue = root.querySelector("#duration-value");
var packetInterval = root.querySelector("#packet-interval");
var autoIntervalCheckbox = root.querySelector("#auto-interval");
var showNetworkMetricsCheckbox = root.querySelector("#show-network-metrics");
var packetCountDisplay = root.querySelector("#packet-count-display");
var packetSize = root.querySelector("#packet-size");
var resetSettingsBtn = root.querySelector("#reset-settings");
var calculationModeGroup = root.querySelector("#calculation-mode-group");
var statusText = root.querySelector("#status-text");
var statusContent = root.querySelector("#status-content");
var statusCursor = root.querySelector("#status-cursor");
function updateTestButton() {
  btnTest.textContent = "TEST PACKET LOSS";
}
function updatePacketCountDisplay() {
  if (testSettings.packetCount === Infinity) {
    packetCountDisplay.textContent = "\u221E Unlimited packets";
  } else {
    packetCountDisplay.textContent = `${testSettings.packetCount.toLocaleString()} packets`;
  }
}
function updateCalculationModeVisibility() {
  if (!calculationModeGroup) return;
  const isMaxPreset = testSettings.preset === "stress";
  const isLongDuration = testSettings.duration >= 300 || testSettings.duration === Infinity;
  if (isMaxPreset && isLongDuration) {
    calculationModeGroup.classList.remove("hidden");
    if (!testSettings.calculationMode) {
      testSettings.calculationMode = "realtime";
      root.querySelectorAll('input[name="calculation-mode"]').forEach((radio) => {
        radio.checked = radio.value === "realtime";
      });
    }
  } else {
    calculationModeGroup.classList.add("hidden");
    testSettings.calculationMode = "cumulative";
  }
}
function showFieldValidation(fieldId, validation) {
  const field = root.querySelector(`#${fieldId}`);
  if (!field) return;
  let errorMsg = field.parentElement.querySelector(".field-error-message");
  if (!errorMsg) {
    errorMsg = document.createElement("div");
    errorMsg.className = "field-error-message";
    field.parentElement.appendChild(errorMsg);
  }
  if (!validation.valid) {
    field.classList.add("field-error");
    errorMsg.textContent = validation.error;
    errorMsg.style.display = "block";
  } else {
    field.classList.remove("field-error");
    errorMsg.style.display = "none";
  }
}
function updateSaveButtonState() {
  const startBtn = root.querySelector("#start-test-from-modal");
  if (!startBtn) return;
  const hasErrors = root.querySelectorAll(".field-error").length > 0;
  if (hasErrors) {
    startBtn.disabled = true;
    startBtn.style.opacity = "0.5";
    startBtn.style.cursor = "not-allowed";
    startBtn.title = "Please fix validation errors before starting test";
  } else {
    startBtn.disabled = false;
    startBtn.style.opacity = "1";
    startBtn.style.cursor = "pointer";
    startBtn.title = "";
  }
}
var typewriterInterval = null;
var showTimeoutId = null;
var messageQueue = [];
var isProcessingQueue = false;
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  isProcessingQueue = true;
  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    if (statusText && statusText.classList.contains("hidden") && !showTimeoutId) {
      statusText.classList.remove("hidden");
    }
    if (statusText && statusText.classList.contains("hidden")) {
      isProcessingQueue = false;
      return;
    }
    await new Promise((resolve) => {
      typeWriter(message, statusContent, 10, resolve);
    });
    const holdTime = messageQueue.length > 0 ? 800 : 1200;
    await new Promise((resolve) => setTimeout(resolve, holdTime));
  }
  isProcessingQueue = false;
}
function typeWriter(text, element, speed = 10, onComplete) {
  if (typewriterInterval) clearInterval(typewriterInterval);
  if (statusText) statusText.classList.remove("cursor-blinking");
  if (statusContent) statusContent.textContent = "";
  let i = 0;
  typewriterInterval = setInterval(() => {
    if (i < text.length) {
      if (statusContent) statusContent.textContent = text.substring(0, i + 1);
      i++;
    } else {
      clearInterval(typewriterInterval);
      typewriterInterval = null;
      if (statusText) statusText.classList.add("cursor-blinking");
      if (onComplete) onComplete();
    }
  }, speed);
}
function updateStatusText(message) {
  if (!statusText) return;
  messageQueue.push(message);
  processMessageQueue();
}
function showConnectingState() {
  if (!statusText) return;
  if (showTimeoutId) clearTimeout(showTimeoutId);
  showTimeoutId = setTimeout(() => {
    if (statusText) statusText.classList.remove("hidden");
    if (messageQueue.length === 0) {
      messageQueue.push("Gathering network paths");
    }
    processMessageQueue();
    showTimeoutId = null;
  }, 500);
}
function hideConnectingState() {
  if (!statusText) return;
  if (showTimeoutId) {
    clearTimeout(showTimeoutId);
    showTimeoutId = null;
  }
  messageQueue = [];
  isProcessingQueue = false;
  if (typewriterInterval) {
    clearInterval(typewriterInterval);
    typewriterInterval = null;
  }
  statusText.classList.add("hidden");
}
async function startTest() {
  const direction = testSettings.direction;
  const count = testSettings.packetCount;
  const interval = testSettings.packetInterval;
  const duration = testSettings.duration;
  const size = testSettings.packetSize;
  const autoInterval = testSettings.autoInterval;
  const calculationMode = testSettings.calculationMode;
  const realtimeWindow = testSettings.realtimeWindow;
  startOverlay.classList.add("hidden");
  showConnectingState();
  isTestFinished = false;
  root.classList.remove("clickable");
  try {
    await testEngine.startTest(count, interval, direction, duration, size, autoInterval, calculationMode, realtimeWindow);
  } catch (e) {
    hideConnectingState();
    throw e;
  }
}
function showSettings() {
  settingsModal.classList.add("active");
}
function hideSettings() {
  settingsModal.classList.remove("active");
}
root.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.preset;
    testSettings.preset = preset;
    root.setAttribute("data-preset", preset);
    root.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const config = PRESETS[preset];
    testSettings.packetInterval = config.interval;
    testSettings.calculationMode = null;
    const maxLabel = root.querySelector(".slider-labels span:last-child");
    const platform = window.TEST_CONFIG?.platform || "web";
    const allowInfinity = platform === "self" && config.duration === Infinity;
    if (allowInfinity) {
      durationSlider.disabled = false;
      durationSlider.max = "3660";
      durationSlider.value = "3660";
      testSettings.duration = Infinity;
      testSettings.packetCount = Infinity;
      durationValue.textContent = "Unlimited";
      updatePacketCountDisplay();
      if (maxLabel) maxLabel.textContent = "Unlimited";
    } else {
      durationSlider.disabled = false;
      durationSlider.max = "300";
      durationSlider.value = config.duration;
      testSettings.duration = config.duration;
      testSettings.packetCount = config.count;
      durationValue.textContent = config.duration >= 60 ? `${Math.floor(config.duration / 60)}m ${config.duration % 60}s`.replace(" 0s", "") : `${config.duration}s`;
      updatePacketCountDisplay();
      if (maxLabel) maxLabel.textContent = "5m";
    }
    packetInterval.value = config.interval;
    updateTestButton();
    updatePacketCountDisplay();
    updateCalculationModeVisibility();
    saveSettings();
  });
});
root.querySelectorAll('input[name="direction"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    testSettings.direction = radio.value;
    saveSettings();
  });
});
root.querySelectorAll('input[name="calculation-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    testSettings.calculationMode = radio.value;
    saveSettings();
  });
});
durationSlider.addEventListener("input", (e) => {
  const value = parseInt(e.target.value);
  const maxLabel = root.querySelector(".slider-labels span:last-child");
  const platform = window.TEST_CONFIG?.platform || "web";
  const allowInfinity = platform === "self" && value >= 3660;
  if (allowInfinity) {
    testSettings.duration = Infinity;
    testSettings.packetCount = Infinity;
    durationValue.textContent = "Unlimited";
    updatePacketCountDisplay();
    if (maxLabel) maxLabel.textContent = "Unlimited";
  } else {
    testSettings.duration = value;
    if (testSettings.packetInterval > 0) {
      const count = Math.ceil(value * 1e3 / testSettings.packetInterval);
      testSettings.packetCount = count;
      updatePacketCountDisplay();
    }
    durationValue.textContent = value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s`.replace(" 0s", "") : `${value}s`;
    if (maxLabel && parseInt(durationSlider.max) <= 300) {
      maxLabel.textContent = "5m";
    } else if (maxLabel && parseInt(durationSlider.max) > 300) {
      const maxTime = parseInt(durationSlider.max);
      if (maxTime >= 3600) {
        maxLabel.textContent = `${Math.floor(maxTime / 60)}m`;
      }
    }
  }
  updateCalculationModeVisibility();
  saveSettings();
});
packetInterval.addEventListener("input", (e) => {
  if (testSettings.autoInterval) {
    testSettings.autoInterval = false;
    if (autoIntervalCheckbox) {
      autoIntervalCheckbox.checked = false;
    }
  }
  const platform = window.TEST_CONFIG?.platform || "web";
  const validation = InputValidator.validatePacketInterval(e.target.value, platform);
  showFieldValidation("packet-interval", validation);
  updateSaveButtonState();
});
packetInterval.addEventListener("change", (e) => {
  const platform = window.TEST_CONFIG?.platform || "web";
  const validation = InputValidator.validatePacketInterval(e.target.value, platform);
  if (validation.valid) {
    testSettings.packetInterval = validation.value;
    e.target.value = validation.value;
    if (testSettings.duration !== Infinity) {
      const count = Math.ceil(testSettings.duration * 1e3 / validation.value);
      testSettings.packetCount = count;
      updatePacketCountDisplay();
    }
    saveSettings();
  } else {
    e.target.value = testSettings.packetInterval;
  }
});
root.querySelectorAll(".size-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const size = parseInt(btn.dataset.size);
    testSettings.packetSize = size;
    packetSize.value = size;
    root.querySelectorAll(".size-preset-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const validation = { valid: true };
    showFieldValidation("packet-size", validation);
    updateSaveButtonState();
    saveSettings();
  });
});
packetSize.addEventListener("input", (e) => {
  const platform = window.TEST_CONFIG?.platform || "web";
  const validation = InputValidator.validatePacketSize(e.target.value, platform);
  showFieldValidation("packet-size", validation);
  updateSaveButtonState();
});
packetSize.addEventListener("change", (e) => {
  const platform = window.TEST_CONFIG?.platform || "web";
  const validation = InputValidator.validatePacketSize(e.target.value, platform);
  if (validation.valid) {
    testSettings.packetSize = validation.value;
    e.target.value = validation.value;
    root.querySelectorAll(".size-preset-btn").forEach((b) => b.classList.remove("active"));
    saveSettings();
  } else {
    e.target.value = testSettings.packetSize;
  }
});
autoIntervalCheckbox.addEventListener("change", (e) => {
  testSettings.autoInterval = e.target.checked;
  if (e.target.checked) {
    const defaultInterval = PRESETS[testSettings.preset].interval;
    testSettings.packetInterval = defaultInterval;
    packetInterval.value = defaultInterval;
    const validation = { valid: true };
    showFieldValidation("packet-interval", validation);
    updateSaveButtonState();
  }
  saveSettings();
});
showNetworkMetricsCheckbox.addEventListener("change", (e) => {
  testSettings.showNetworkMetrics = e.target.checked;
  visualEngine.setShowNetworkMetrics(e.target.checked);
  saveSettings();
});
function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}
function getCookie(name) {
  try {
    const value = document.cookie.split("; ").reduce((r, v) => {
      const parts = v.split("=");
      return parts[0] === name ? decodeURIComponent(parts[1]) : r;
    }, "");
    if (value && typeof value === "string") {
      return value;
    }
    return "";
  } catch (e) {
    return "";
  }
}
function saveSettings() {
  try {
    const settingsToSave = {
      ...testSettings,
      duration: testSettings.duration === Infinity ? "Infinity" : testSettings.duration,
      packetCount: testSettings.packetCount === Infinity ? "Infinity" : testSettings.packetCount
    };
    localStorage.setItem("testSettings", JSON.stringify(settingsToSave));
  } catch (e) {
    ErrorHandler.showToast("Settings could not be saved. Your changes may be lost.", "warning");
  }
}
function loadSettings() {
  try {
    const saved = localStorage.getItem("testSettings");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!parsed.version || parsed.version < SETTINGS_VERSION) {
        localStorage.removeItem("testSettings");
        return null;
      }
      if (parsed.duration === "Infinity") parsed.duration = Infinity;
      if (parsed.packetCount === "Infinity") parsed.packetCount = Infinity;
      const platform = window.TEST_CONFIG?.platform || "web";
      const validation = InputValidator.validateSettings(parsed, platform);
      if (!validation.valid) {
        localStorage.removeItem("testSettings");
        return null;
      }
      return parsed;
    }
  } catch (e) {
    ErrorHandler.showToast("Could not load saved settings. Using defaults.", "warning");
  }
  return null;
}
function sanitizeSettingsForPlatform(saved) {
  const sanitized = { ...saved };
  const platform = window.TEST_CONFIG?.platform || "web";
  const maxPresetConfig = PRESETS.stress;
  if (platform === "web") {
    if (sanitized.duration === Infinity || sanitized.duration > 300) {
      sanitized.duration = 300;
    }
  }
  if (platform === "web") {
    if (sanitized.packetCount === Infinity || sanitized.packetCount > 6e3) {
      sanitized.packetCount = 6e3;
    }
  }
  const maxPacketSize = platform === "web" ? 1500 : 9e3;
  if (sanitized.packetSize && sanitized.packetSize > maxPacketSize) {
    sanitized.packetSize = maxPacketSize;
  }
  if (sanitized.preset === "stress" && platform === "web") {
    if (sanitized.duration > 300 || sanitized.duration === Infinity) {
      sanitized.duration = 300;
    }
    if (sanitized.packetCount > 6e3 || sanitized.packetCount === Infinity) {
      sanitized.packetCount = 6e3;
    }
  }
  return sanitized;
}
function restoreSettings() {
  const saved = loadSettings();
  if (!saved) {
    root.setAttribute("data-preset", testSettings.preset);
    root.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === testSettings.preset);
    });
    return;
  }
  const sanitized = sanitizeSettingsForPlatform(saved);
  Object.assign(testSettings, sanitized);
  root.setAttribute("data-preset", testSettings.preset);
  root.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === testSettings.preset);
  });
  root.querySelectorAll('input[name="direction"]').forEach((radio) => {
    radio.checked = radio.value === testSettings.direction;
  });
  const maxLabel = root.querySelector(".slider-labels span:last-child");
  const platform = window.TEST_CONFIG?.platform || "web";
  if (testSettings.duration === Infinity) {
    durationSlider.max = "3660";
    durationSlider.value = "3660";
    durationValue.textContent = "Unlimited";
    if (maxLabel) maxLabel.textContent = "Unlimited";
  } else {
    if (platform === "self" && testSettings.duration > 300) {
      durationSlider.max = "3660";
    } else {
      durationSlider.max = "300";
    }
    durationSlider.value = Math.min(testSettings.duration, parseInt(durationSlider.max));
    durationValue.textContent = testSettings.duration >= 60 ? `${Math.floor(testSettings.duration / 60)}m ${testSettings.duration % 60}s`.replace(" 0s", "") : `${testSettings.duration}s`;
    if (maxLabel) {
      maxLabel.textContent = durationSlider.max === "3660" ? "60m" : "5m";
    }
  }
  packetInterval.value = testSettings.packetInterval;
  if (autoIntervalCheckbox) {
    autoIntervalCheckbox.checked = testSettings.autoInterval !== void 0 ? testSettings.autoInterval : true;
  }
  if (showNetworkMetricsCheckbox) {
    const showMetrics = testSettings.showNetworkMetrics !== void 0 ? testSettings.showNetworkMetrics : false;
    showNetworkMetricsCheckbox.checked = showMetrics;
    visualEngine.setShowNetworkMetrics(showMetrics);
  }
  updatePacketCountDisplay();
  packetSize.value = testSettings.packetSize;
  root.querySelectorAll(".size-preset-btn").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.size) === testSettings.packetSize);
  });
  if (testSettings.calculationMode) {
    root.querySelectorAll('input[name="calculation-mode"]').forEach((radio) => {
      radio.checked = radio.value === testSettings.calculationMode;
    });
  }
  updateCalculationModeVisibility();
}
function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme, silent = false) {
  document.documentElement.setAttribute("data-theme", theme);
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  if (themeBtn) {
    themeBtn.textContent = theme === "light" ? "Dark" : "Light";
  }
  if (!silent) {
    window.dispatchEvent(new CustomEvent("themeChanged", { detail: { theme } }));
  }
}
function getUrlParameter(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}
function initializeTheme() {
  const urlMode = getUrlParameter("mode");
  let theme;
  if (urlMode === "dark" || urlMode === "light") {
    theme = urlMode;
  } else {
    const savedTheme = getCookie("mode");
    theme = savedTheme || getSystemTheme();
  }
  applyTheme(theme);
}
themeBtn.addEventListener("click", () => {
  const currentTheme = document.documentElement.getAttribute("data-theme");
  const newTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(newTheme);
  setCookie("mode", newTheme);
});
window.addEventListener("themeChanged", (e) => {
  const newTheme = e.detail.theme;
  if (document.documentElement.getAttribute("data-theme") !== newTheme) {
    applyTheme(newTheme, true);
  }
});
btnTest.addEventListener("click", startTest);
btnSettings.addEventListener("click", showSettings);
closeSettings.addEventListener("click", hideSettings);
startTestFromModal.addEventListener("click", () => {
  hideSettings();
  startTest();
});
resetSettingsBtn.addEventListener("click", () => {
  if (confirm("Reset all settings to defaults?")) {
    localStorage.removeItem("testSettings");
    testSettings = {
      version: SETTINGS_VERSION,
      preset: "default",
      duration: 30,
      direction: "both",
      packetInterval: 15.625,
      packetCount: 1920,
      packetSize: 100,
      autoInterval: true,
      showNetworkMetrics: false,
      calculationMode: null,
      realtimeWindow: 10
    };
    root.setAttribute("data-preset", "default");
    root.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === "default");
    });
    root.querySelectorAll('input[name="direction"]').forEach((radio) => {
      radio.checked = radio.value === "both";
    });
    durationSlider.max = "300";
    durationSlider.value = "30";
    durationValue.textContent = "30s";
    const maxLabel = root.querySelector(".slider-labels span:last-child");
    if (maxLabel) maxLabel.textContent = "5m";
    packetInterval.value = "15.625";
    if (autoIntervalCheckbox) {
      autoIntervalCheckbox.checked = true;
    }
    updatePacketCountDisplay();
    packetSize.value = "100";
    document.querySelectorAll(".size-preset-btn").forEach((b) => b.classList.remove("active"));
    if (showNetworkMetricsCheckbox) {
      showNetworkMetricsCheckbox.checked = false;
      visualEngine.setShowNetworkMetrics(false);
    }
    document.querySelectorAll('input[name="calculation-mode"]').forEach((radio) => {
      radio.checked = false;
    });
    updateCalculationModeVisibility();
  }
});
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) {
    hideSettings();
  }
});
function handleResultsRedirect(stats) {
  const platform = window.TEST_CONFIG?.platform || "web";
  if (platform !== "web") return;
  const resultsUrl = new URL("https://openpacketloss.com/results");
  resultsUrl.searchParams.set("sent", stats.sent);
  resultsUrl.searchParams.set("received", stats.received);
  resultsUrl.searchParams.set("lost", stats.lost);
  resultsUrl.searchParams.set("loss", stats.currentLoss.toFixed(2));
  resultsUrl.searchParams.set("jitter", stats.jitter.toFixed(2));
  resultsUrl.searchParams.set("rtt", (stats.rtt || 0).toFixed(2));
  resultsUrl.searchParams.set("c2s_loss", (stats.c2sLossPercent || 0).toFixed(2));
  resultsUrl.searchParams.set("s2c_loss", (stats.s2cLossPercent || 0).toFixed(2));
  resultsUrl.searchParams.set("ooo", (stats.outOfOrderPercent || 0).toFixed(2));
  const REDIRECT_DELAY_MS = 3500;
  setTimeout(() => {
    window.location.href = resultsUrl.toString();
  }, REDIRECT_DELAY_MS);
}
testEngine.on("test:completed", (stats) => {
  isTestFinished = true;
  lastTestStats = stats;
  const platform = window.TEST_CONFIG?.platform || "web";
  if (platform === "self") {
    root.classList.add("clickable");
  }
  handleResultsRedirect(stats);
  setTimeout(() => {
  }, 2e3);
});
window.addEventListener("beforeunload", () => {
  testEngine.cleanup();
});
function initializePlatformFeatures() {
  const platform = window.TEST_CONFIG?.platform || "web";
  if (platform === "self") {
    root.addEventListener("click", (e) => {
      if (!isTestFinished) return;
      const interactiveSelectors = "button, input, select, textarea, .modal-content, a, label, details, summary";
      if (!e.target.closest(interactiveSelectors)) {
        const resultsUrl = new URL("https://openpacketloss.com/results/");
        if (lastTestStats) {
          resultsUrl.searchParams.set("sent", lastTestStats.sent);
          resultsUrl.searchParams.set("received", lastTestStats.received);
          resultsUrl.searchParams.set("lost", lastTestStats.lost);
          resultsUrl.searchParams.set("loss", lastTestStats.currentLoss.toFixed(2));
          resultsUrl.searchParams.set("jitter", lastTestStats.jitter.toFixed(2));
          resultsUrl.searchParams.set("rtt", (lastTestStats.rtt || 0).toFixed(2));
          resultsUrl.searchParams.set("c2s_loss", (lastTestStats.c2sLossPercent || 0).toFixed(2));
          resultsUrl.searchParams.set("s2c_loss", (lastTestStats.s2cLossPercent || 0).toFixed(2));
          resultsUrl.searchParams.set("ooo", (lastTestStats.outOfOrderPercent || 0).toFixed(2));
        }
        window.open(resultsUrl.toString(), "_blank");
      }
    });
  }
}
initializeTheme();
restoreSettings();
initializePlatformFeatures();
updateTestButton();
updatePacketCountDisplay();
if (window.TEST_CONFIG && window.TEST_CONFIG.platform === "web") {
  const packetSizeInput = document.getElementById("packet-size");
  if (packetSizeInput) {
    packetSizeInput.max = "1500";
    if (parseInt(packetSizeInput.value) > 1500) {
      packetSizeInput.value = "1500";
      testSettings.packetSize = 1500;
    }
  }
  const jumboBtn = document.querySelector('.size-preset-btn[data-size="9000"]');
  if (jumboBtn) {
    jumboBtn.style.display = "none";
  }
} else {
}
