/* ImageLab — worker.js
 * 重い処理を Web Worker に逃がすための実行係。
 *
 * ■ なぜ普通の Worker ではないのか
 *
 * このデモ集は index.html をダブルクリックするだけで動くことを優先しているので、
 * ページの出自は file:// になる。この状態では
 *
 *   new Worker('js/kernel.js')
 *     → SecurityError: Script at 'file:///…' cannot be accessed from origin 'null'
 *
 * となって外部ファイルの Worker は作れない。一方、コードを文字列から組み立てて
 * Blob URL 経由で渡す形なら通る（Chrome 152 で実測。検証ページは
 * 90_保管庫/2026-09-02_Worker可否テスト_ImageLab.html に残してある）。
 * ただし Worker の中から importScripts('js/core.js') も同じ理由で弾かれるため、
 * 必要な部品は全部この文字列に同梱するしかない。
 *
 * そこで、
 *   ・core.js の U のうち U.workerExports に挙げたものを toString() で文字列化
 *   ・各 op の kernel / prepare も同じく文字列化
 *   ・それらを1つの Blob にまとめ、全 op 共通のワーカーとして使い回す
 * という組み立てにしている。処理の本体は js/ops/*.js に置いたまま動くので、
 * アルゴリズムを二重に持つことにはならない。
 *
 * ■ 分担のしかた
 *
 * 画像を横に切って行帯に分け、ワーカー1つが連続した1区画を受け持つ。
 * 区画の中はさらに step 行ずつに刻んで、焼き上がるたびに帯を送り返す。
 * こうすると入力の複製はワーカーあたり1回で済み、進捗と逐次プレビューは
 * 細かく届く。実測（12コア機・640×480・バイラテラル）で 418 ms → 116 ms。
 *
 * ■ 使い方
 *
 *   var job = IL.jobs.run(op, srcImageData, params, {
 *     onBand:     function (band, y0, y1, stage, stages) {},  // 帯が1つ焼けるたび
 *     onProgress: function (ratio, elapsedMs) {},
 *     onDone:     function (dst, ms, how, used, report, cpu) {},  // how: worker/main/sync
 *     onError:    function (err) {}
 *   });
 *   job.cancel();   // 走っている途中でも止まる
 *
 * report は、処理が prepare で ctx.report に入れた値がそのまま返ってくるもの。
 * 画像とは別に数値を伝えたいとき（PSNR / SSIM など）に使う。無ければ null。
 *
 * ■ 時間を2つ返す（ms と cpu）
 *
 *   ms  … ジョブを作ってから結果が返るまでの実時間。「画面に出るまで」の待ち時間。
 *   cpu … prepare と kernel の中だけを測った合計。アルゴリズムそのものの重さ。
 *
 * この2つを分けたのは、ms だけだと処理どうしを比べられないため。
 * 軽い処理は sync（setTimeout を1回はさんで一気に）で走るが、その setTimeout が
 * 返ってくるまでに、直前の描画やレイアウトが割り込む。実測で 50 ms の処理が
 * 200 ms と出ることがあり、しかも測るたびに変わる。逆に Worker 経路では計算が
 * 別スレッドで進むので、ms は「待った時間」であって「計算した時間」ではない。
 *
 * cpu は計算している区間だけを測るので、経路が違っても素直に比べられる。
 * 並列で走ったときは全ワーカーぶんの合計になるので、ms より大きくなる
 * （8並列で cpu 418 ms・ms 116 ms、といった形で分担の効き目がそのまま出る）。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;
  var J = (IL.jobs = {});

  /* 12コア機の実測では 8 並列で 3.6 倍。これ以上は頭打ちなので上限を切る */
  var MAX_WORKERS = 8;
  var CORES = Math.max(1, Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 4));

  /* 帯1本あたりの目安。細かいほど進捗と逐次プレビューが滑らかになるが、
     帯の外まで読み直す「のりしろ」のぶん無駄が増える */
  var BAND_MS_WORKER = 25;
  var BAND_MS_MAIN = 12;

  /* 見積りがこれを下回るなら、往復させず一気に処理したほうが速い。
     スライダーを動かしながら見せる用途では、この足切りが効く */
  J.threshold = 120;

  J.cores = CORES;

  /* ---------------- Worker が使えるかどうか ---------------- */

  var avail = null;

  J.available = function () {
    if (avail !== null) return avail;
    avail = false;
    try {
      if (typeof Worker === 'function' && typeof Blob === 'function' &&
          typeof URL !== 'undefined' && URL.createObjectURL) {
        var u = URL.createObjectURL(new Blob(['self.close();'], { type: 'text/javascript' }));
        var wk = new Worker(u);          /* 弾かれる環境ならここで例外が出る */
        wk.terminate();
        URL.revokeObjectURL(u);
        avail = true;
      }
    } catch (e) {
      console.warn('Web Worker が使えないので、メインスレッドの時間分割で処理します：' + e.message);
    }
    return avail;
  };

  /* ---------------- ワーカーのソースを組み立てる ---------------- */

  /* ワーカー本体。K に各 op の kernel、P に prepare が入っている前提で動く */
  function workerBody(self) {
    var now = function () { return self.performance ? self.performance.now() : Date.now(); };
    self.onmessage = function (e) {
      var d = e.data;
      try {
        /* 転送されてきたバッファをそのまま包む（ここでは複製しない） */
        var src = new ImageData(new Uint8ClampedArray(d.buf), d.w, d.h);

        /* prepare も計算のうち。モルフォロジーのように中身がほぼ prepare の
           処理では、ここを測らないと cpu が 0 に近くなってしまう。

           d.bench が立っている処理（＝処理時間そのものを見せる処理）は、
           1回空回ししてから d.bench 回まわし、**いちばん速かった回**を採る。
           1回きりだと、ワーカーが作られたばかりで温まっていなかったり、
           PC 側が別の仕事で混んでいたりするだけで数倍に振れる。
           node docs/_bench.js が「1回空回ししてから3回計測」しているのと同じ理屈で、
           最小値は「じゃまが入らなければこの速さ」を指すので、比較に使える。 */
        var ctx = null, prep, tp, b, e;
        if (d.bench > 0) {
          if (P[d.op]) P[d.op](src, d.p);          /* 空回し（JIT を温める） */
          prep = Infinity;
          for (b = 0; b < d.bench; b++) {
            tp = now();
            ctx = P[d.op] ? P[d.op](src, d.p) : null;
            e = now() - tp;
            if (e < prep) prep = e;
          }
        } else {
          tp = now();
          ctx = P[d.op] ? P[d.op](src, d.p) : null;
          prep = now() - tp;
        }
        /* ctx.report があれば、数値を最後の帯に添えてページ側へ返す
           （PSNR / SSIM のように、画像とは別に伝えたいものの通り道） */
        var report = (ctx && ctx.report) ? ctx.report : null;
        for (var y = d.y0; y < d.y1; y += d.step) {
          var y1 = (y + d.step < d.y1) ? y + d.step : d.y1;
          var t0 = now();
          var band = K[d.op](src, d.p, y, y1, ctx);
          /* prepare のぶんは最初の帯にだけ乗せる（合計が二重にならないように） */
          var ms = (now() - t0) + prep; prep = 0;
          var buf = band.data.buffer;
          var last = (y1 >= d.y1);
          self.postMessage(
            { ok: true, y0: y, y1: y1, ms: ms, last: last, out: buf,
              report: last ? report : null },
            [buf]);
        }
      } catch (err) {
        self.postMessage({ ok: false, last: true, msg: String((err && err.message) || err) });
      }
    };
  }

  function fnSource(label, fn) {
    var s = fn.toString();
    if (!/^function\b/.test(s)) {
      throw new Error(label + ' は「function (…) {…}」の形で書いてください' +
                      '（メソッド短縮記法やアロー関数は Worker 用に文字列化できません）');
    }
    return s;
  }

  var srcCache = null;

  function buildSource() {
    if (srcCache) return srcCache;
    var s = ['"use strict";'];

    /* core.js の U を組み直す */
    s.push('var U = {};');
    U.workerConsts.forEach(function (k) {
      s.push('U.' + k + ' = ' + JSON.stringify(U[k]) + ';');
    });
    U.workerExports.forEach(function (k) {
      s.push('U.' + k + ' = ' + fnSource('U.' + k, U[k]) + ';');
    });

    /* kernel を持つ op を全部積む。1つの Blob を全 op で使い回す */
    s.push('var K = {}, P = {};');
    IL.ops.forEach(function (op) {
      if (typeof op.kernel !== 'function') return;
      s.push('K[' + JSON.stringify(op.id) + '] = ' + fnSource(op.id + ' の kernel', op.kernel) + ';');
      if (typeof op.prepare === 'function') {
        s.push('P[' + JSON.stringify(op.id) + '] = ' + fnSource(op.id + ' の prepare', op.prepare) + ';');
      }
    });

    /* 処理の中から別の処理を呼ぶための入口（core.js の U.opKernel / U.opPrepare）。
       ページ側は IL.opById を引くが、ここには IL が無いので上の K / P を引く。
       名前と呼び方が同じなので、op 側のコードは両方の環境でそのまま動く */
    s.push('U.opKernel = function (id) {');
    s.push('  if (!K[id]) throw new Error("kernel が無い処理です: " + id);');
    s.push('  return K[id];');
    s.push('};');
    s.push('U.opPrepare = function (id) {');
    s.push('  return P[id] || function () { return null; };');
    s.push('};');

    s.push(';(' + workerBody.toString() + ')(self);');
    srcCache = s.join('\n');
    return srcCache;
  }

  /* 組み立てたソースを覗きたいとき用（開発中の確認に使う） */
  J.source = function () { return buildSource(); };

  /* ---------------- ワーカーの使い回し ---------------- */

  var idle = [], blobUrl = null;

  function acquire() {
    if (idle.length) return idle.pop();
    if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([buildSource()], { type: 'text/javascript' }));
    return new Worker(blobUrl);
  }

  function release(wk) {
    wk.onmessage = null; wk.onerror = null;
    if (idle.length < CORES) idle.push(wk);
    else wk.terminate();
  }

  /* ---------------- ジョブ ---------------- */

  function Job(op, src, params, cb) {
    this.op = op; this.src = src; this.params = params; this.cb = cb || {};
    this.w = src.width; this.h = src.height;
    this.stages = op.stages ? op.stages(params) : 1;
    this.stage = 0;
    this.rowsDone = 0;
    this.rowsTotal = this.h * this.stages;
    this.cur = src;            /* 今の段の入力 */
    this.dst = null;           /* 今の段の出力 */
    this.workers = [];
    this.cancelled = false;
    this.failed = false;
    this.mode = 'sync';
    this.used = 1;             /* 実際に使ったワーカーの数 */
    this.report = null;        /* 処理が返してきた数値（PSNR など）。無ければ null */
    this.cpu = 0;              /* prepare と kernel の中だけを測った合計（ミリ秒） */
    this.t0 = performance.now();
  }

  Job.prototype.start = function () {
    var self = this;
    if (this.mode === 'sync') {
      /* 軽い処理は今までどおり一気に。往復のぶんスライダーの追従が鈍るのを避ける */
      setTimeout(function () {
        if (self.cancelled) return;
        var out;
        try {
          /* 第3引数は数値を受け取る箱。apply が ctx.report を見つけたら
             self.report に入れてくれる（registry.js の自動生成 apply を参照） */
          var tc = performance.now();
          out = self.op.apply(self.src, self.params, self);
          self.cpu += performance.now() - tc;
        } catch (e) {
          if (self.cb.onError) self.cb.onError(e);
          return;
        }
        self.dst = out;
        self._finish();
      }, 0);
      return;
    }
    this._startStage();
  };

  /* 帯の厚み。時間の見積りから決めつつ、のりしろの2倍は確保する。
   *
   * 薄くしすぎると、帯の外まで読み直すぶんの無駄がふくらむ。逆に厚くしすぎると
   * 帯の本数が減り、分担できるワーカーの数も減る。のりしろの2倍だと
   * 読み直しは最悪2倍だが、そのぶん倍の数で分担できるので差し引きで速い。
   * （ガウシアン σ=10・480行だと、4倍なら4並列、2倍なら8並列になる） */
  Job.prototype._step = function (targetMs) {
    var op = this.op, p = this.params, h = this.h;
    var halo = op.halo ? op.halo(p) : 0;
    var perRow = op.cost ? (op.cost(this.w, h, p) / this.stages) / h : 0;
    var byTime = perRow > 0 ? Math.round(targetMs / perRow) : h;
    return Math.max(1, Math.min(h, Math.max(8, halo * 2, byTime)));
  };

  Job.prototype._startStage = function () {
    this.dst = new ImageData(this.w, this.h);
    if (this.mode === 'worker') this._runWorkers(this._step(BAND_MS_WORKER));
    else this._runSliced(this._step(BAND_MS_MAIN));
  };

  Job.prototype._runWorkers = function (step) {
    var self = this, h = this.h;
    /* 1つのワーカーが受け持つのは連続した1区画。こうすると入力の複製が1回で済む */
    var nw = Math.max(1, Math.min(CORES, Math.floor(h / step)));
    var per = Math.ceil(h / nw);
    var pending = 0;
    var finished = function () { if (--pending === 0) self._stageDone(); };

    for (var i = 0; i < nw; i++) {
      var y0 = i * per;
      var y1 = Math.min(h, y0 + per);
      if (y0 >= y1) break;
      pending++;
      this._dispatch(y0, y1, step, finished);
    }
    this.used = pending;      /* 実際に走らせた数。帯が薄いと CORES より少なくなる */
    if (pending === 0) this._stageDone();
  };

  Job.prototype._dispatch = function (y0, y1, step, done) {
    var self = this;
    var wk = acquire();
    this.workers.push(wk);

    wk.onmessage = function (ev) {
      if (self.cancelled) return;
      var d = ev.data;
      if (!d.ok) { self._fail(new Error(d.msg)); return; }
      if (d.report) self.report = d.report;
      /* ワーカーが「自分の中で計算していた時間」を足していく。
         並列で走っているので、合計は実時間より大きくなる */
      self.cpu += d.ms || 0;
      self._absorb(d.y0, d.y1, new ImageData(new Uint8ClampedArray(d.out), self.w, d.y1 - d.y0));
      if (d.last) { self._retire(wk); done(); }
    };
    wk.onerror = function (ev) {
      if (self.cancelled) return;
      self._fail(new Error(ev.message || 'Worker が異常終了しました'));
    };

    /* 帯の外も読むので、ワーカーには画像全体を渡す。
       同じものを N 部いるので複製し、複製のほうを転送する */
    var buf = this.cur.data.buffer.slice(0);
    wk.postMessage({ op: this.op.id, buf: buf, w: this.w, h: this.h,
                     p: this.params, y0: y0, y1: y1, step: step,
                     bench: this.op.bench | 0 }, [buf]);
  };

  /* Worker が使えないときの受け皿。同じ kernel を帯ごとに呼び、
     12 ms ほど進んだら制御をブラウザへ返す。
     1回目も setTimeout をはさむ：そうしないと軽い画像で onDone が
     IL.jobs.run() の返る前に飛んでしまい、呼び出し側の state.job が食い違う */
  Job.prototype._runSliced = function (step) {
    var self = this;
    var y = 0;
    var ctx = null;

    setTimeout(function tick() {
      if (self.cancelled) return;
      if (ctx === null && self.op.prepare) {
        /* Worker が使えないときの受け皿だが、bench の扱いは合わせておく
           （workerBody と同じ理屈。上のコメントを参照） */
        var reps = self.op.bench | 0, best, tp, e, b;
        if (reps > 0) {
          self.op.prepare(self.cur, self.params);        /* 空回し */
          best = Infinity;
          for (b = 0; b < reps; b++) {
            tp = performance.now();
            ctx = self.op.prepare(self.cur, self.params);
            e = performance.now() - tp;
            if (e < best) best = e;
          }
          self.cpu += best;
        } else {
          tp = performance.now();
          ctx = self.op.prepare(self.cur, self.params);
          self.cpu += performance.now() - tp;
        }
        if (ctx && ctx.report) self.report = ctx.report;
      }
      var t = performance.now();
      try {
        do {
          var y1 = Math.min(self.h, y + step);
          var tk = performance.now();
          var band = self.op.kernel(self.cur, self.params, y, y1, ctx);
          self.cpu += performance.now() - tk;
          self._absorb(y, y1, band);
          y = y1;
        } while (y < self.h && performance.now() - t < BAND_MS_MAIN);
      } catch (e) {
        self._fail(e);
        return;
      }
      if (y >= self.h) self._stageDone();
      else setTimeout(tick, 0);
    }, 0);
  };

  Job.prototype._absorb = function (y0, y1, band) {
    this.dst.data.set(band.data, y0 * this.w * 4);
    this.rowsDone += (y1 - y0);
    if (this.cb.onBand) this.cb.onBand(band, y0, y1, this.stage, this.stages);
    if (this.cb.onProgress) {
      this.cb.onProgress(this.rowsDone / this.rowsTotal, performance.now() - this.t0);
    }
  };

  Job.prototype._retire = function (wk) {
    var i = this.workers.indexOf(wk);
    if (i >= 0) this.workers.splice(i, 1);
    release(wk);
  };

  Job.prototype._stageDone = function () {
    if (this.cancelled || this.failed) return;
    this.stage++;
    if (this.stage < this.stages) {
      this.cur = this.dst;      /* 前の段の結果を次の段の入力にする */
      this._startStage();
      return;
    }
    this._finish();
  };

  Job.prototype._finish = function () {
    var ms = performance.now() - this.t0;
    this._cleanup(false);
    if (this.cb.onDone) {
      this.cb.onDone(this.dst, ms, this.mode, this.used || 1, this.report, this.cpu);
    }
  };

  Job.prototype._fail = function (err) {
    if (this.failed) return;
    this.failed = true;
    this._cleanup(true);

    if (this.mode === 'worker') {
      /* ワーカー側で落ちたなら、以後はメインスレッドの時間分割に切り替えてやり直す。
         固まりはするが、結果が出ないよりはよい。原因は console に残す */
      console.warn('Worker での実行に失敗したので時間分割に切り替えます：' + err.message);
      avail = false;
      this.failed = false;
      this.mode = 'main';
      this.stage = 0; this.rowsDone = 0; this.cur = this.src;
      this.cpu = 0;             /* 途中まで走ったぶんは数えない */
      this.t0 = performance.now();
      this._startStage();
      return;
    }
    if (this.cb.onError) this.cb.onError(err);
  };

  Job.prototype._cleanup = function (kill) {
    for (var i = 0; i < this.workers.length; i++) {
      var wk = this.workers[i];
      wk.onmessage = null; wk.onerror = null;
      /* 走っている最中に止める手立ては terminate しかない。
         Blob URL は作りおきなので、作り直しは数ミリ秒で済む */
      if (kill) { try { wk.terminate(); } catch (e) { /* 無視 */ } }
      else release(wk);
    }
    this.workers.length = 0;
  };

  Job.prototype.cancel = function () {
    if (this.cancelled) return;
    this.cancelled = true;
    this._cleanup(true);
  };

  /* ---------------- 入口 ---------------- */

  /* op.route === 'worker' なら、見積りが軽くても必ずワーカーへ回す。
   *
   * 処理時間そのものを見せる処理（設定を切り替えて速さを比べる実演）でだけ立てる。
   * メインスレッドで走らせると、そのページの大きなヒープ（canvas・ImageData・
   * 直前の結果）を抱えたまま計算することになり、途中に GC が挟まって
   * 実測が2〜5倍に膨れたり、測るたびに変わったりする。
   * 実測：640×480・半径8の膨張で、Node の1スレッドが 四角 40 / 十字 41 / 円 295 ms
   * なのに対し、ブラウザのメインスレッドでは 四角 192 / 十字 198〜71 / 円 154 ms と
   * 形の重さが読めない数字になった（2026-09-06。§5-8 の続き）。
   * ワーカーは自分のヒープしか持たないので、同じ計算が素直な数字で出る。
   *
   * 往復のコストは 640×480 で数ミリ秒（画像の複製2回）。スライダーの追従は
   * むしろ良くなる（メインスレッドが計算で塞がらないため）。 */
  J.run = function (op, src, params, cb) {
    var job = new Job(op, src, params, cb);
    var est = op.cost ? op.cost(src.width, src.height, params) : 0;
    var forced = (op.route === 'worker');

    if (typeof op.kernel !== 'function' || (!forced && est < J.threshold)) job.mode = 'sync';
    else if (J.available()) job.mode = 'worker';
    else job.mode = 'main';

    job.start();
    return job;
  };

  /* 見積り（ミリ秒）。UI から「重い設定です」と出したいとき用 */
  J.estimate = function (op, w, h, p) { return op.cost ? op.cost(w, h, p) : 0; };
})();
