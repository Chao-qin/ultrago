/*!
 * keep-awake —— 后台节流绕行，单文件注入版（静默 / 无全局）
 *
 * 零依赖、零打包。worker 与 audio worklet 源码内联成字符串走 blob URL，不需要任何外部文件。
 *
 * 不写任何全局变量，不产生任何 console 输出。
 * 整个文件是一个表达式，求值结果就是控制句柄：
 *
 *   在业务代码里：   const ka = <本文件内容>;  ka.every(1000, tick)
 *   控制台粘贴：     直接粘，DevTools 会回显句柄；想留住就 var ka = (<本文件内容>)
 *   只要劫持效果：   粘完不管它，存量 setInterval/setTimeout 自动受益
 *
 * 句柄：
 *   .every(ms, fn) / .after(ms, fn) / .clear(id)   显式调度（不依赖劫持）
 *   .clock(ms, fn) -> Promise                      音频线程时钟，粒度约 2.7ms，需一次用户交互
 *   .status()                                      各通道状态
 *   .stop()                                        全部停掉并还原被劫持的全局方法
 *
 * 配置：改文件末尾那个对象字面量。
 *
 * 已知限制（不是 bug，是物理约束）：
 *   - 注入前就已在跑的原生 interval 接管不了（拿不到句柄）。要全覆盖需放在业务 bundle 之前。
 *   - 页面被浏览器冻结/丢弃时一切停摆，任何手段都绕不过。
 *   - 严格 CSP（worker-src 不含 blob:）下 worker 建不起来，会自动退化为原生定时器，
 *     此时后台仍会被节流；用 status().degraded 判断。
 */
;(function (opts) {
  'use strict'

  var CFG = {
    hijack: true, // 劫持 window.setInterval/setTimeout，让存量业务代码无改动受益
    minDelay: 50, // 低于此延时走原生：setTimeout(fn,0) 绕 worker 会破坏 UI 时序语义
    rtc: true, // WebRTC loopback：免 intensive throttling + 免省电模式冻结，用户无感
    worklet: true, // 音频线程时钟：粒度约 2.7ms，增益 0 所以静音、不出 🔊 图标
    audio: false, // 超声波保活：效果最强但会出 🔊 图标、可被用户静音，默认关
    gain: 0.001, // 约 −60 dBFS。必须越过 Chrome 静音线才有效（0.00001 太小，无效）
    freq: 19000,
    mediaAware: true, // 页面自己出声时，音频保活自动让路
    maskNative: true, // 让被劫持的函数 toString() 看起来像原生实现
    onError: null, // function(err) —— 不设就完全静默
  }
  for (var k in opts || {}) if (Object.prototype.hasOwnProperty.call(opts, k)) CFG[k] = opts[k]

  var fail = function (e) {
    if (typeof CFG.onError === 'function') {
      try {
        CFG.onError(e instanceof Error ? e : new Error(String(e)))
      } catch (_) {}
    }
  }

  // 用全局注册表 symbol 认出「已经注入过」，同时它对 Object.keys / for-in /
  // JSON.stringify / getOwnPropertyNames 都不可见，只有 getOwnPropertySymbols 能看到。
  var MARK = Symbol.for('ka.hijacked')
  if (window.setInterval[MARK]) return window.setInterval[MARK]

  // ---------- 0. 先抓原生定时器（必须在任何劫持之前）----------
  var N = {
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  }

  var urls = []
  var mkUrl = function (src) {
    var u = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
    urls.push(u)
    return u
  }
  var drop = function (u) {
    try {
      URL.revokeObjectURL(u)
    } catch (_) {}
    var i = urls.indexOf(u)
    if (i >= 0) urls.splice(i, 1)
  }

  // ---------- 1. Worker 调度器 ----------

  var WORKER_SRC = [
    'var t=new Map();',
    'self.onmessage=function(e){',
    ' var d=e.data;',
    ' if(d.type==="start"){',
    '  var s=0;',
    '  var h=d.repeat',
    '   ?setInterval(function(){self.postMessage({id:d.id,seq:++s})},d.delay)',
    '   :setTimeout(function(){t.delete(d.id);self.postMessage({id:d.id,seq:1})},d.delay);',
    '  t.set(d.id,{h:h,r:d.repeat});',
    ' }else if(d.type==="stop"){',
    '  var x=t.get(d.id);',
    '  if(x){x.r?clearInterval(x.h):clearTimeout(x.h);t.delete(d.id)}',
    ' }else if(d.type==="stopAll"){',
    '  t.forEach(function(x){x.r?clearInterval(x.h):clearTimeout(x.h)});t.clear()',
    ' }',
    '};',
  ].join('')

  var ID_OFFSET = 1e9 // 与原生 timer ID 空间隔开，避免撞号
  var BACKLOG_RATIO = 0.5 // 距上次触发不足半个周期就到达 = 积压补投，丢弃

  var worker = null
  var degraded = null
  try {
    var wu = mkUrl(WORKER_SRC)
    worker = new Worker(wu)
    drop(wu) // worker 已经在加载了，URL 可以立刻撤销，不留痕
  } catch (e) {
    // 常见于严格 CSP（worker-src 不含 blob:）。明确退化到原生，
    // 而不是静默变成「定时器全都不触发」。
    degraded = 'Worker 创建失败：' + e.message
    fail(e)
  }

  var entries = new Map()
  var seqCounter = 0
  var stats = { fired: 0, dropped: 0 }

  if (worker) {
    worker.onerror = function (e) {
      fail(new Error('worker error: ' + (e && e.message)))
    }
    worker.onmessage = function (e) {
      var id = e.data.id
      var tickSeq = e.data.seq
      var it = entries.get(id)
      if (!it || tickSeq <= it.lastSeq) return

      var now = performance.now()

      // 主线程被长任务占住时 postMessage 会堆积，放开后一口气全投递。
      // 判据用「到达间隔」而不是「seq 与真实时间的偏差」——后者在页面被冻结后
      // 会让 seq 永久落后，之后每一跳都被当成积压丢掉，定时器从此永久静默。
      if (it.repeat && it.lastFiredAt !== null && now - it.lastFiredAt < it.delay * BACKLOG_RATIO) {
        it.lastSeq = tickSeq
        stats.dropped++
        return
      }

      var late = it.lastFiredAt === null ? 0 : now - it.lastFiredAt - it.delay
      it.lastSeq = tickSeq
      it.lastFiredAt = now
      if (!it.repeat) entries.delete(id)
      stats.fired++

      // 错误隔离：一个回调抛错不能打断 onmessage，否则拖垮所有定时器
      try {
        it.cb({ seq: tickSeq, late: late })
      } catch (err) {
        fail(err)
      }
    }
  }

  function schedule(delay, cb, repeat) {
    var id = ID_OFFSET + ++seqCounter

    if (!worker) {
      var run = function () {
        if (!repeat) entries.delete(id)
        stats.fired++
        try {
          cb({ seq: 0, late: 0 })
        } catch (err) {
          fail(err)
        }
      }
      var h = repeat ? N.setInterval(run, delay) : N.setTimeout(run, delay)
      entries.set(id, { nativeHandle: h, repeat: repeat })
      return id
    }

    entries.set(id, { cb: cb, delay: delay, repeat: repeat, lastSeq: 0, lastFiredAt: null })
    worker.postMessage({ type: 'start', id: id, delay: delay, repeat: repeat })
    return id
  }

  // 返回 false 表示「不是我管的 id」，调用方据此回退给原生
  function clearScheduled(id) {
    var it = entries.get(id)
    if (!it) return false
    entries.delete(id)
    if (it.nativeHandle != null) {
      it.repeat ? N.clearInterval(it.nativeHandle) : N.clearTimeout(it.nativeHandle)
    } else if (worker) {
      worker.postMessage({ type: 'stop', id: id })
    }
    return true
  }

  // ---------- 2. 页面冻结 / 恢复 ----------
  // 冻结时 worker 一起冻，什么都跑不了（浏览器行为，绕不过）。
  // 这里只保证恢复后立刻正常继续，不会被积压判定误杀。
  var frozenAt = null
  var lastFreeze = null
  function onFreeze() {
    frozenAt = performance.now()
  }
  function onResumed() {
    if (frozenAt === null) return
    lastFreeze = { frozenMs: performance.now() - frozenAt, at: Date.now() }
    frozenAt = null
    entries.forEach(function (it) {
      if (it.repeat) it.lastFiredAt = null // 恢复后第一跳别被当成积压
    })
  }
  function onPageHide(e) {
    if (e.persisted) onFreeze()
  }
  function onPageShow(e) {
    if (e.persisted) onResumed()
  }
  document.addEventListener('freeze', onFreeze)
  document.addEventListener('resume', onResumed)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)

  // ---------- 3. 全局劫持（可选层）----------
  var hijacked = null

  // 只改我们自己这 4 个函数的 toString，不动 Function.prototype.toString。
  // 后者能骗过更多检测，但会影响页面上所有代码，代价不成比例。
  // 诚实说明：Function.prototype.toString.call(setInterval) 仍然能看出来。
  function mask(fn, name, len) {
    if (!CFG.maskNative) return fn
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true })
      Object.defineProperty(fn, 'length', { value: len, configurable: true })
      Object.defineProperty(fn, 'toString', {
        value: function () {
          return 'function ' + name + '() { [native code] }'
        },
        configurable: true,
        writable: true,
      })
    } catch (_) {}
    return fn
  }

  function installHijack() {
    var prev = {
      setInterval: window.setInterval,
      clearInterval: window.clearInterval,
      setTimeout: window.setTimeout,
      clearTimeout: window.clearTimeout,
    }

    var si = function (cb, delay) {
      delay = delay || 0
      var args = [].slice.call(arguments, 2)
      if (delay < CFG.minDelay) return prev.setInterval.apply(window, arguments)
      return schedule(
        delay,
        function () {
          cb.apply(null, args)
        },
        true,
      )
    }
    var st = function (cb, delay) {
      delay = delay || 0
      var args = [].slice.call(arguments, 2)
      if (delay < CFG.minDelay) return prev.setTimeout.apply(window, arguments)
      return schedule(
        delay,
        function () {
          cb.apply(null, args)
        },
        false,
      )
    }
    // 未登记的 id 一律回退原生，否则劫持之前创建的定时器永远清不掉
    var ci = function (id) {
      if (!clearScheduled(id)) prev.clearInterval.call(window, id)
    }
    var ct = function (id) {
      if (!clearScheduled(id)) prev.clearTimeout.call(window, id)
    }

    window.setInterval = mask(si, 'setInterval', 1)
    window.setTimeout = mask(st, 'setTimeout', 1)
    window.clearInterval = mask(ci, 'clearInterval', 1)
    window.clearTimeout = mask(ct, 'clearTimeout', 1)

    hijacked = {
      uninstall: function () {
        window.setInterval = prev.setInterval
        window.clearInterval = prev.clearInterval
        window.setTimeout = prev.setTimeout
        window.clearTimeout = prev.clearTimeout
      },
    }
  }
  if (CFG.hijack) installHijack()

  // ---------- 4. WebRTC loopback 保活 ----------
  // Chrome 把「RTCPeerConnection + open RTCDataChannel」同时列为
  // intensive throttling 豁免 和 省电模式冻结豁免。自己连自己，不需要信令服务器。
  var rtc = null
  function startRtc() {
    if (typeof RTCPeerConnection === 'undefined') return Promise.resolve(null)
    var a = new RTCPeerConnection()
    var b = new RTCPeerConnection()
    a.onicecandidate = function (e) {
      if (e.candidate) b.addIceCandidate(e.candidate).catch(function () {})
    }
    b.onicecandidate = function (e) {
      if (e.candidate) a.addIceCandidate(e.candidate).catch(function () {})
    }
    var dc = a.createDataChannel('x')

    return a
      .createOffer()
      .then(function (o) {
        return a.setLocalDescription(o)
      })
      .then(function () {
        return b.setRemoteDescription(a.localDescription)
      })
      .then(function () {
        return b.createAnswer()
      })
      .then(function (ans) {
        return b.setLocalDescription(ans)
      })
      .then(function () {
        return a.setRemoteDescription(b.localDescription)
      })
      .then(function () {
        return new Promise(function (ok, err) {
          if (dc.readyState === 'open') return ok()
          dc.onopen = ok
          N.setTimeout(function () {
            dc.readyState === 'open' ? ok() : err(new Error('DataChannel 5 秒内未打开'))
          }, 5000)
        })
      })
      .then(function () {
        rtc = {
          state: function () {
            return dc.readyState
          },
          stop: function () {
            dc.close()
            a.close()
            b.close()
          },
        }
        return rtc
      })
  }

  // ---------- 5. 音频线程时钟（需一次用户交互）----------
  // AudioWorklet 的 process() 跑在音频实时线程，每 128 帧调用一次（48kHz 约 2.7ms），
  // 不走页面 timer 队列。增益接 0 再连 destination：必须连上才会被渲染线程拉取，
  // 而增益 0 保证完全无声 —— 拿到时钟但不出 🔊 图标、不会被用户静音。
  var WORKLET_SRC = [
    'class C extends AudioWorkletProcessor{',
    ' constructor(o){super();',
    '  this.i=((o.processorOptions&&o.processorOptions.intervalMs)||1000)/1000;',
    '  this.n=currentTime+this.i;this.s=0}',
    ' process(){',
    '  if(currentTime>=this.n){',
    '   this.n+=this.i;',
    '   if(this.n<currentTime)this.n=currentTime+this.i;',
    '   this.port.postMessage(++this.s)}',
    '  return true}}',
    'registerProcessor("ka-clock",C);',
  ].join('')

  var audioCtx = null
  var workletReady = null
  var clocks = []

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx
    var Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    audioCtx = new Ctx()
    var resume = function () {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {})
    }
    audioCtx.addEventListener('statechange', resume)
    document.addEventListener('visibilitychange', resume)
    resume()
    return audioCtx
  }

  function ensureWorklet() {
    if (workletReady) return workletReady
    var ctx = ensureAudioCtx()
    if (!ctx || typeof AudioWorkletNode === 'undefined') {
      workletReady = Promise.reject(new Error('AudioWorklet 不可用'))
      workletReady.catch(function () {})
      return workletReady
    }
    var u = mkUrl(WORKLET_SRC)
    workletReady = ctx.audioWorklet.addModule(u).then(
      function () {
        drop(u)
        return ctx
      },
      function (e) {
        drop(u)
        throw e
      },
    )
    return workletReady
  }

  function makeClock(intervalMs, fn) {
    return ensureWorklet().then(function (ctx) {
      var node = new AudioWorkletNode(ctx, 'ka-clock', { processorOptions: { intervalMs: intervalMs } })
      var silent = ctx.createGain()
      silent.gain.value = 0
      node.connect(silent)
      silent.connect(ctx.destination)
      node.port.onmessage = function () {
        try {
          fn()
        } catch (err) {
          fail(err)
        }
      }
      var handle = {
        stop: function () {
          node.port.onmessage = null
          node.disconnect()
          silent.disconnect()
          var i = clocks.indexOf(handle)
          if (i >= 0) clocks.splice(i, 1)
        },
      }
      clocks.push(handle)
      return handle
    })
  }

  // ---------- 6. 超声波音频保活（需一次用户交互，默认关）----------
  var audio = null
  function startAudio() {
    var ctx = ensureAudioCtx()
    if (!ctx) return null

    var safeFreq = Math.min(CFG.freq, ctx.sampleRate * 0.45) // 越过奈奎斯特会混叠成可听噪音
    var osc = ctx.createOscillator()
    var gain = ctx.createGain()
    var analyser = ctx.createAnalyser()
    analyser.fftSize = 2048

    osc.frequency.setValueAtTime(safeFreq, ctx.currentTime)
    gain.gain.setValueAtTime(CFG.gain, ctx.currentTime)
    osc.connect(gain)
    gain.connect(analyser)
    analyser.connect(ctx.destination)
    osc.start()

    var buf = new Float32Array(analyser.fftSize)
    var yielded = false

    audio = {
      freq: safeFreq,
      dbfs: function () {
        analyser.getFloatTimeDomainData(buf)
        var s = 0
        for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i]
        var rms = Math.sqrt(s / buf.length)
        return rms > 0 ? 20 * Math.log10(rms) : -Infinity
      },
      isYielded: function () {
        return yielded
      },
      // 页面自己在出声时让路：标签页本来就 audible，我们这一路纯属多余，
      // 继续播只会带来「宠物听得见 / 🔊 图标引诱用户静音标签页 / 白耗电」。
      setYielded: function (v) {
        if (v === yielded) return
        yielded = v
        gain.gain.setValueAtTime(v ? 0 : CFG.gain, ctx.currentTime)
      },
      stop: function () {
        try {
          osc.stop()
        } catch (_) {}
        gain.disconnect()
        analyser.disconnect()
      },
    }

    if (CFG.mediaAware) {
      schedule(
        1000,
        function () {
          var els = document.querySelectorAll('video, audio')
          var playing = false
          for (var i = 0; i < els.length; i++) {
            var el = els[i]
            if (!el.paused && !el.ended && !el.muted && el.volume > 0 && el.readyState >= 2) {
              playing = true
              break
            }
          }
          audio.setYielded(playing)
        },
        true,
      )
    }
    return audio
  }

  // ---------- 7. 需要用户交互的通道，挂到首次交互 ----------
  var gestureEvents = ['pointerdown', 'keydown', 'touchstart']
  function onGesture() {
    disarm()
    if (CFG.worklet) ensureWorklet().catch(fail)
    if (CFG.audio) {
      try {
        startAudio()
      } catch (e) {
        fail(e)
      }
    }
  }
  function disarm() {
    for (var i = 0; i < gestureEvents.length; i++) {
      window.removeEventListener(gestureEvents[i], onGesture, true)
    }
  }
  function arm() {
    for (var i = 0; i < gestureEvents.length; i++) {
      window.addEventListener(gestureEvents[i], onGesture, { capture: true, once: true })
    }
  }

  // ---------- 8. 句柄 ----------
  var api = {
    every: function (ms, fn) {
      return schedule(ms, fn, true)
    },
    after: function (ms, fn) {
      return schedule(ms, fn, false)
    },
    clear: function (id) {
      return clearScheduled(id)
    },
    /** 音频线程时钟，粒度约 2.7ms。返回 Promise，需要页面上先发生过一次用户交互 */
    clock: function (ms, fn) {
      return makeClock(ms, fn)
    },
    status: function () {
      return {
        driver: worker ? 'worker' : 'native',
        degraded: degraded,
        hijacked: !!hijacked,
        fired: stats.fired,
        dropped: stats.dropped,
        active: entries.size,
        rtc: rtc ? rtc.state() : CFG.rtc ? 'pending' : 'off',
        worklet: workletReady ? 'ready' : CFG.worklet ? 'awaiting-gesture' : 'off',
        audio: audio ? (audio.isYielded() ? 'yielded' : audio.dbfs().toFixed(1) + ' dBFS') : CFG.audio ? 'awaiting-gesture' : 'off',
        lastFreeze: lastFreeze,
      }
    },
    stop: function () {
      document.removeEventListener('freeze', onFreeze)
      document.removeEventListener('resume', onResumed)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      disarm()
      entries.forEach(function (_, id) {
        clearScheduled(id)
      })
      clocks.slice().forEach(function (c) {
        c.stop()
      })
      if (audio) audio.stop()
      if (rtc) rtc.stop()
      if (worker) {
        worker.postMessage({ type: 'stopAll' })
        worker.terminate()
      }
      if (audioCtx) audioCtx.close().catch(function () {})
      if (hijacked) hijacked.uninstall()
      urls.slice().forEach(drop)
    },
  }

  // 认领标记：藏在函数的 symbol 属性上，重复注入时直接返回同一个句柄
  if (hijacked) {
    try {
      Object.defineProperty(window.setInterval, MARK, { value: api, enumerable: false, configurable: true })
    } catch (_) {}
  }

  // ---------- 9. 启动 ----------
  if (CFG.rtc) startRtc().catch(fail)
  if (CFG.worklet || CFG.audio) arm()

  return api
})({
  // 想改配置就动这里，不需要任何外部变量
  // audio: true,
  // hijack: false,
  // onError: function (e) { /* 默认完全静默 */ },
})
