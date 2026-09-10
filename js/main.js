/* ImageLab — main.js
 * 画面制御。registry のテーブルを読んで処理リストとパラメータ UI を組み立て、
 * 画像の読み込み・実行・表示・保存をつなぐ。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    fullCanvas: null,     /* 読み込んだ画像を原寸で持つ */
    srcImg: null,         /* 作業解像度に落とした入力 ImageData */
    dstImg: null,
    opId: 'none',
    params: {},
    maxSide: 640,        /* 既定値。スライダーを動かしながら見せられる速度を優先している */
    histChannel: 'y',
    sourceName: '—',
    job: null,           /* 走っている IL.jobs のジョブ。新しい実行が来たら捨てる */
    progressive: true    /* 計算中の途中経過を見せるか。実演では入れる／作業中は切る */
  };

  /* 逐次表示の入切だけは次に開いたときも覚えておく。
     file:// でも localStorage は使えるが、環境によっては触れないので必ず包む */
  function prefGet(key, dflt) {
    try { var v = localStorage.getItem('imagelab.' + key); return v === null ? dflt : v === '1'; }
    catch (e) { return dflt; }
  }
  function prefSet(key, val) {
    try { localStorage.setItem('imagelab.' + key, val ? '1' : '0'); } catch (e) { /* 無視 */ }
  }

  /* パラメータ欄に置いた「絵で編集するもの」の再描画。画像が変わったら描き直す。
     処理を切り替えるたびに作り直されるので、buildParams の頭で捨てる */
  var viewer, curveWidget = null, spectrumWidget = null;

  function refreshParamWidgets() {
    if (curveWidget) curveWidget();
    if (spectrumWidget) spectrumWidget();
  }

  /* ---------------- 画像の読み込み ---------------- */

  function setFullFromImageData(img, name) {
    var c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    state.fullCanvas = c;
    state.sourceName = name;
    rebuildSource();
  }

  function setFullFromImage(imgEl, name) {
    var c = document.createElement('canvas');
    c.width = imgEl.naturalWidth; c.height = imgEl.naturalHeight;
    c.getContext('2d').drawImage(imgEl, 0, 0);
    state.fullCanvas = c;
    state.sourceName = name;
    rebuildSource();
  }

  /* 作業解像度に合わせて縮小した ImageData を作り直す */
  function rebuildSource() {
    var fc = state.fullCanvas;
    if (!fc) return;
    var scale = 1;
    if (state.maxSide > 0) scale = Math.min(1, state.maxSide / Math.max(fc.width, fc.height));
    var w = Math.max(1, Math.round(fc.width * scale));
    var h = Math.max(1, Math.round(fc.height * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(fc, 0, 0, w, h);
    state.srcImg = g.getImageData(0, 0, w, h);
    $('img-info').textContent = state.sourceName + '　' + w + '×' + h +
      (scale < 1 ? '（原寸 ' + fc.width + '×' + fc.height + ' から縮小）' : '');
    refreshParamWidgets();
    run();
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file);
    var im = new Image();
    im.onload = function () {
      setFullFromImage(im, file.name);
      URL.revokeObjectURL(url);
    };
    im.onerror = function () {
      alert('この画像は読み込めませんでした：' + file.name);
      URL.revokeObjectURL(url);
    };
    im.src = url;
  }

  /* ---------------- 実行 ---------------- */

  var runTimer = 0;

  /* 重い処理は IL.jobs が Web Worker へ逃がす（js/worker.js）。
   *
   * 走っている途中で新しい実行が来たら、前のジョブは捨てる。順番待ちにすると
   * スライダーを動かしたぶんだけ計算が積み上がってしまう。
   * そのうえで、重い設定のときだけ少し待ってから走らせる。ドラッグの途中の値まで
   * いちいち計算しては捨てる、という無駄をなくすため。軽い処理は今までどおり即座に。 */
  function run() {
    if (!state.srcImg) return;
    if (state.job) { state.job.cancel(); state.job = null; }
    clearTimeout(runTimer);

    var op = IL.opById[state.opId];
    var est = IL.jobs.estimate(op, state.srcImg.width, state.srcImg.height, state.params);
    if (est < IL.jobs.threshold) runNow();
    else runTimer = setTimeout(runNow, 90);
  }

  function runNow() {
    var op = IL.opById[state.opId];

    /* 逐次表示は、帯が届く重い処理のときだけ入れる。
       軽い処理でやると、原画に戻してすぐ描き直すことになり、
       スライダーを動かすたびにちらつく。
       FFT のように帯へ分けられない処理（halo が画像の高さ以上）も同じ理由で外す。
       帯が1本しか来ないので、原画に戻して1回で塗り替えるだけになる */
    var est = IL.jobs.estimate(op, state.srcImg.width, state.srcImg.height, state.params);
    var oneBand = !!op.halo && op.halo(state.params) >= state.srcImg.height;
    var progressive = state.progressive && typeof op.kernel === 'function' &&
                      est >= IL.jobs.threshold && !oneBand;

    setProgress(0, 0, null);
    viewer.setOverlay(null);      /* 前の処理の見出しを残さない */
    if (progressive) viewer.beginProgressive(state.srcImg);

    state.job = IL.jobs.run(op, state.srcImg, state.params, {
      onBand: progressive ? function (band, y0) { viewer.putBand(band, y0); } : null,

      onProgress: function (ratio, ms) { setProgress(ratio, ms, op); },

      onDone: function (out, ms, how, used, report, cpu) {
        state.job = null;
        state.dstImg = out;
        viewer.setImages(state.srcImg, state.dstImg);
        viewer.setOverlay(report && report.tiles);
        IL.hist.draw($('hist'), state.srcImg, state.dstImg, state.histChannel);
        IL.hist.drawProfile($('profile'), state.srcImg, state.dstImg, viewer.cursor);
        showStats(op, ms, how, used, report, cpu);
      },

      onError: function (e) {
        state.job = null;
        console.error(e);
        state.dstImg = U.cloneImageData(state.srcImg);
        viewer.setImages(state.srcImg, state.dstImg);
        setProgress(0, 0, null);
        $('stat-rows').innerHTML = '<div class="stat"><span>エラー</span><b>' +
          escapeHTML(e.message) + '</b></div>';
        fitBottom();
      }
    });
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /* 進捗バー。ratio が 0 のときは畳んでおく */
  function setProgress(ratio, ms, op) {
    var el = $('prog');
    if (!op || ratio >= 1) { el.classList.remove('on'); return; }
    el.classList.add('on');
    $('prog-bar').style.width = (ratio * 100).toFixed(1) + '%';
    $('prog-text').textContent = '計算中 ' + Math.round(ratio * 100) + '%　' + (ms / 1000).toFixed(1) + ' 秒';
  }

  /* 時間は2つ出す。
   *
   *   計算時間      … prepare と kernel の中だけを測った合計（cpu）。
   *                   処理どうしを比べるのはこちら。経路が変わっても意味が変わらない。
   *   画面に出るまで … ジョブを作ってから結果が返るまでの実時間（ms）。
   *                   軽い処理は setTimeout を1回はさむので、直前の描画が割り込むと
   *                   ここだけ大きくぶれる。Worker 経路では計算が別スレッドで進むので、
   *                   逆に計算時間より小さくなる（並列なら合計の 1/N 近くまで縮む）。
   *
   * 「処理時間」という1つの数にまとめていたころは、四角（同期・50 ms の計算）が
   * 円（Worker・300 ms の計算）より大きく出ることがあり、形ごとの比較ができなかった。
   *
   * op.bench を立てた処理は、1回空回ししてから bench 回まわして最小を採っている
   * （js/worker.js の workerBody）。そのぶん「画面に出るまで」は
   * 計算時間の bench+1 倍あたりになる。ここに但し書きを出しておく。 */
  function showStats(op, ms, how, used, report, cpu) {
    setProgress(1, 0, null);
    var n = state.srcImg.width * state.srcImg.height;
    /* 何並列で回したかは、同好会で見せるときの話の種になる */
    var where = { worker: 'Worker ' + used + ' 並列',
                  main: 'メインスレッド（時間分割）',
                  sync: 'メインスレッド' }[how] || '';
    var calc = (typeof cpu === 'number' && cpu > 0) ? cpu : ms;
    var html =
      '<div class="stat"><span>処理</span><b>' + escapeHTML(op.label) + '</b></div>' +
      '<div class="stat"><span>計算時間</span><b>' + calc.toFixed(1) + ' ms' +
        (used > 1 ? '<i>（' + used + ' 並列の合計）</i>'
                  : (op.bench > 1 ? '<i>（' + op.bench + '回の最小）</i>' : '')) + '</b></div>' +
      '<div class="stat"><span>画面に出るまで</span><b>' + ms.toFixed(1) + ' ms</b></div>' +
      '<div class="stat"><span>実行</span><b>' + where + '</b></div>' +
      '<div class="stat"><span>画素数</span><b>' + n.toLocaleString() + '</b></div>' +
      '<div class="stat"><span>1画素あたり</span><b>' + (calc * 1e6 / n).toFixed(0) + ' ns</b></div>' +
      '<div class="stat" id="pixel-readout"><span>カーソル</span><b>—</b></div>';

    /* 処理が返してきた数値（PSNR / SSIM など）。中身は処理側で組み立て済み */
    if (report && report.rows) {
      html += '<div class="stat-sep"></div>';
      report.rows.forEach(function (r) {
        html += '<div class="stat"><span>' + escapeHTML(r[0]) + '</span><b>' +
                escapeHTML(r[1]) + '</b></div>';
      });
    }

    /* metrics を立てた処理は、原画との PSNR / SSIM をここで測って足す。
       処理後の画像はもう手元にあるので、計算し直す必要はない */
    if (op.metrics && state.dstImg &&
        state.dstImg.width === state.srcImg.width &&
        state.dstImg.height === state.srcImg.height) {
      var ps = U.psnr(state.srcImg, state.dstImg);
      var ss = U.ssim(state.srcImg, state.dstImg);
      html += '<div class="stat-sep"></div>' +
              '<div class="stat"><span>PSNR（原画と）</span><b>' +
              (isFinite(ps) ? ps.toFixed(1) + ' dB' : '∞') + '</b></div>' +
              '<div class="stat"><span>SSIM（原画と）</span><b>' + ss.toFixed(3) + '</b></div>';
    }

    $('stat-rows').innerHTML = html;
    fitBottom();
  }

  /* 下部の高さを、右下の行数に合わせて伸び縮みさせる。
   *
   * 168px 固定だと、基本の6行で高さを使い切ってしまい、処理が返してきた行
   * （比較 op なら見出し＋4手法で5行）が下に隠れる。スクロールできるようには
   * してあるが、画面共有で見せるものなので、まずは全部出しておきたい。
   *
   * 高さは CSS 変数ひとつ（--bottom-h）で、下部と main の両方が読んでいる。
   * 画面の 42% までを上限にして、ビューアを潰しすぎないようにする。
   * 高さが動いたら hist / profile / ビューアは測り直しが要る
   * （どれも getBoundingClientRect で内部サイズを決めているため）。 */
  var BOTTOM_MIN = 168;
  function fitBottom() {
    var root = document.documentElement, st = $('stats');
    var cur = parseFloat(root.style.getPropertyValue('--bottom-h')) || BOTTOM_MIN;
    /* いったん最小に戻してから測る。伸ばしたままだと scrollHeight が
       「箱の高さ」を返してしまい、行が減ったときに縮まなくなる */
    root.style.setProperty('--bottom-h', BOTTOM_MIN + 'px');
    var need = Math.ceil(st.scrollHeight) + 2;          /* padding 込みの中身の高さ */
    var max = Math.max(BOTTOM_MIN, Math.round(window.innerHeight * 0.42));
    var h = Math.max(BOTTOM_MIN, Math.min(need, max));
    if (Math.abs(h - cur) < 1) { root.style.setProperty('--bottom-h', cur + 'px'); return; }
    root.style.setProperty('--bottom-h', h + 'px');
    IL.hist.draw($('hist'), state.srcImg, state.dstImg, state.histChannel);
    IL.hist.drawProfile($('profile'), state.srcImg, state.dstImg, viewer.cursor);
    viewer.render();
  }

  /* ---------------- 処理リスト ---------------- */

  function buildOpList() {
    var nav = $('oplist');
    nav.innerHTML = '';
    IL.categories.forEach(function (cat) {
      var ops = IL.ops.filter(function (o) { return o.category === cat.id; });
      if (!ops.length) return;
      var hd = document.createElement('div');
      hd.className = 'cat';
      hd.textContent = cat.label;
      nav.appendChild(hd);
      ops.forEach(function (op) {
        var b = document.createElement('button');
        b.className = 'op';
        b.dataset.id = op.id;
        b.textContent = op.label;
        b.addEventListener('click', function () { selectOp(op.id); });
        nav.appendChild(b);
      });
    });
  }

  function selectOp(id) {
    state.opId = id;
    var op = IL.opById[id];
    state.params = IL.defaultParams(op);
    Array.prototype.forEach.call(document.querySelectorAll('#oplist .op'), function (b) {
      b.classList.toggle('active', b.dataset.id === id);
    });
    buildParams(op);
    buildDoc(op);
    run();
  }

  /* ---------------- パラメータ UI ---------------- */

  function buildParams(op) {
    var host = $('params');
    host.innerHTML = '';
    curveWidget = null; spectrumWidget = null;   /* 前の処理のウィジェットは捨てる */
    if (!op.params.length) {
      host.innerHTML = '<p class="empty">この処理にパラメータはありません。</p>';
      return;
    }
    op.params.forEach(function (def) {
      var row = document.createElement('div');
      row.className = 'prow';
      row.dataset.key = def.key;

      var lab = document.createElement('label');
      lab.className = 'plabel';
      lab.innerHTML = '<span>' + def.label + '</span><b class="pval"></b>';
      row.appendChild(lab);

      if (def.type === 'range') {
        var r = document.createElement('input');
        r.type = 'range';
        r.min = def.min; r.max = def.max; r.step = def.step;
        r.value = state.params[def.key];
        r.addEventListener('input', function () {
          state.params[def.key] = parseFloat(r.value);
          updateValueLabels(op);
          run();
        });
        row.appendChild(r);
      } else if (def.type === 'select') {
        var s = document.createElement('select');
        def.options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.value; opt.textContent = o.label;
          s.appendChild(opt);
        });
        s.value = state.params[def.key];
        s.addEventListener('change', function () {
          state.params[def.key] = s.value;
          updateVisibility(op);
          updateValueLabels(op);
          refreshParamWidgets();   /* 境界処理を変えるとスペクトルの見た目も変わる */
          run();
        });
        row.appendChild(s);
      } else if (def.type === 'checkbox') {
        var wrapc = document.createElement('div');
        wrapc.className = 'pcheck';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!state.params[def.key];
        cb.id = 'cb-' + def.key;
        var cl = document.createElement('label');
        cl.setAttribute('for', cb.id);
        cl.textContent = 'オン / オフ';
        cb.addEventListener('change', function () {
          state.params[def.key] = cb.checked;
          refreshParamWidgets();   /* マスクの反転は編集画面の見た目にも効く */
          run();
        });
        wrapc.appendChild(cb); wrapc.appendChild(cl);
        row.appendChild(wrapc);
      } else if (def.type === 'curve') {
        row.appendChild(buildCurve(def));
      } else if (def.type === 'spectrum') {
        row.appendChild(buildSpectrum(def));
      }
      host.appendChild(row);
    });
    updateVisibility(op);
    updateValueLabels(op);
  }

  function updateValueLabels(op) {
    op.params.forEach(function (def) {
      var row = document.querySelector('#params .prow[data-key="' + def.key + '"]');
      if (!row) return;
      var b = row.querySelector('.pval');
      if (!b) return;
      var v = state.params[def.key];
      if (def.type === 'range') b.textContent = def.format ? def.format(v) : String(v);
      else b.textContent = '';
    });
  }

  function updateVisibility(op) {
    op.params.forEach(function (def) {
      var row = document.querySelector('#params .prow[data-key="' + def.key + '"]');
      if (!row) return;
      var show = def.when ? def.when(state.params) : true;
      row.style.display = show ? '' : 'none';
    });
  }

  /* --- トーンカーブの編集ウィジェット --- */
  function buildCurve(def) {
    /* 編集対象のオブジェクトをここで掴んでおく。
       state.params は処理を切り替えるたび新しいオブジェクトに差し替わるので、
       owner[def.key] を毎回引くと、描画が遅れて走ったときに
       「もう別の処理に切り替わっていて curve が無い」状態で呼ばれて落ちる。 */
    var owner = state.params;

    var box = document.createElement('div');
    box.className = 'curvebox';

    var cv = document.createElement('canvas');
    cv.className = 'curve';
    box.appendChild(cv);

    var presets = document.createElement('div');
    presets.className = 'presets';
    [['リニア', [[0, 0], [255, 255]]],
     ['S字（強め）', [[0, 0], [64, 40], [128, 128], [192, 216], [255, 255]]],
     ['逆S字', [[0, 0], [64, 88], [128, 128], [192, 168], [255, 255]]],
     ['暗部を持ち上げ', [[0, 0], [64, 110], [160, 200], [255, 255]]],
     ['ネガ', [[0, 255], [255, 0]]]
    ].forEach(function (pr) {
      var b = document.createElement('button');
      b.textContent = pr[0];
      b.addEventListener('click', function () {
        owner[def.key] = IL.cloneValue(pr[1]);
        drawCurve();
        run();
      });
      presets.appendChild(b);
    });
    box.appendChild(presets);

    var size = 236;
    function drawCurve() {
      var dpr = window.devicePixelRatio || 1;
      cv.width = size * dpr; cv.height = size * dpr;
      cv.style.width = size + 'px'; cv.style.height = size + 'px';
      var g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#141821'; g.fillRect(0, 0, size, size);

      /* 入力側のヒストグラム（薄く敷いて、どこを動かすと効くか見せる） */
      if (state.srcImg) {
        var hh = U.histogramRGB(state.srcImg).y;
        var mx = 1;
        for (var q = 1; q < 255; q++) if (hh[q] > mx) mx = hh[q];
        g.fillStyle = 'rgba(120,140,175,0.30)';
        for (var v = 0; v < 256; v++) {
          var bh = Math.min(1, hh[v] / mx) * size * 0.55;
          g.fillRect(v / 255 * size, size - bh, size / 256 + 0.6, bh);
        }
      }

      g.strokeStyle = '#252d3c'; g.lineWidth = 1;
      for (var i = 1; i < 4; i++) {
        g.beginPath(); g.moveTo(size * i / 4, 0); g.lineTo(size * i / 4, size); g.stroke();
        g.beginPath(); g.moveTo(0, size * i / 4); g.lineTo(size, size * i / 4); g.stroke();
      }
      g.strokeStyle = '#39435a';
      g.beginPath(); g.moveTo(0, size); g.lineTo(size, 0); g.stroke();

      var lut = U.curveLUT(owner[def.key]);
      g.beginPath();
      for (var x = 0; x < 256; x++) {
        var px = x / 255 * size, py = size - lut[x] / 255 * size;
        if (x === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokeStyle = '#7fd4ff'; g.lineWidth = 2; g.stroke();

      owner[def.key].forEach(function (pt) {
        var px = pt[0] / 255 * size, py = size - pt[1] / 255 * size;
        g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2);
        g.fillStyle = '#fff'; g.fill();
        g.strokeStyle = '#2b6d8c'; g.lineWidth = 1.5; g.stroke();
      });
    }

    function toCurve(e) {
      var r = cv.getBoundingClientRect();
      return [U.clamp(Math.round((e.clientX - r.left) / size * 255), 0, 255),
              U.clamp(Math.round((1 - (e.clientY - r.top) / size) * 255), 0, 255)];
    }
    function nearest(pt) {
      var pts = owner[def.key], best = -1, bd = 1e9;
      pts.forEach(function (q, i) {
        var d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
        if (d < bd) { bd = d; best = i; }
      });
      return { index: best, dist: bd };
    }

    var drag = -1;
    cv.addEventListener('pointerdown', function (e) {
      if (e.button === 2) return;
      var pt = toCurve(e), nr = nearest(pt);
      var pts = owner[def.key];
      if (nr.dist < 14) { drag = nr.index; }
      else { pts.push(pt); pts.sort(function (a, b) { return a[0] - b[0]; }); drag = pts.indexOf(pt); }
      cv.setPointerCapture(e.pointerId);
      drawCurve(); run();
    });
    cv.addEventListener('pointermove', function (e) {
      if (drag < 0) return;
      var pts = owner[def.key], pt = toCurve(e);
      /* 両端は横に動かさない（0 と 255 の入力が必ず定義されるように） */
      if (drag === 0) pt[0] = Math.min(pt[0], 0);
      if (drag === pts.length - 1) pt[0] = Math.max(pt[0], 255);
      /* 隣を追い越さない */
      if (drag > 0) pt[0] = Math.max(pt[0], pts[drag - 1][0] + 1);
      if (drag < pts.length - 1) pt[0] = Math.min(pt[0], pts[drag + 1][0] - 1);
      pts[drag] = pt;
      drawCurve(); run();
    });
    cv.addEventListener('pointerup', function (e) {
      drag = -1;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    });
    cv.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var pts = owner[def.key];
      if (pts.length <= 2) return;
      var nr = nearest(toCurve(e));
      if (nr.dist < 16 && nr.index > 0 && nr.index < pts.length - 1) {
        pts.splice(nr.index, 1);
        drawCurve(); run();
      }
    });

    curveWidget = drawCurve;
    setTimeout(drawCurve, 0);
    return box;
  }

  /* --- スペクトルマスクの編集ウィジェット ---
   *
   * 原画のスペクトルを敷いて、その上を筆でなぞって遮る。
   * 中央のビューアには「マスクを掛けたあとのスペクトル」を大きく出せるので
   * （処理側の「ビューアに出すもの」）、大画面で位置を指しながらここで塗る使い方になる。
   *
   * owner を掴んでおく理由は buildCurve と同じ（state.params は処理を切り替えると
   * 別のオブジェクトに差し替わるため）。 */
  function buildSpectrum(def) {
    var owner = state.params;
    var G = IL.MASK_GRID;
    var CW = 236;                       /* 表示幅。高さは画像の縦横比に合わせる */

    var box = document.createElement('div');
    box.className = 'maskbox';

    var cv = document.createElement('canvas');
    cv.className = 'maskcanvas';
    cv._ch = 160;                       /* 実際の高さは draw() が画像の縦横比から決める */
    box.appendChild(cv);

    /* 筆の太さ */
    var brow = document.createElement('div');
    brow.className = 'maskrow';
    var blab = document.createElement('span');
    blab.textContent = '筆の太さ';
    var br = document.createElement('input');
    br.type = 'range'; br.min = 1; br.max = 24; br.step = 1; br.value = 5;
    var bval = document.createElement('b');
    bval.textContent = '5';
    br.addEventListener('input', function () { bval.textContent = br.value; });
    brow.appendChild(blab); brow.appendChild(br); brow.appendChild(bval);
    box.appendChild(brow);

    /* プリセット。ここから筆で足し引きするのが手早い */
    var presets = document.createElement('div');
    presets.className = 'presets';
    [['全通過', null],
     ['ローパス', function (u, v, r) { return r > 0.12; }],
     ['ハイパス', function (u, v, r) { return r < 0.06; }],
     ['バンドパス', function (u, v, r) { return r < 0.05 || r > 0.16; }],
     /* 十字は「画像の右端と左端の食い違い」が生む成分。DC の周りは残す */
     ['十字を落とす', function (u, v, r) {
       return r > 0.015 && (Math.abs(u) < 0.008 || Math.abs(v) < 0.008);
     }]
    ].forEach(function (pr) {
      var b = document.createElement('button');
      b.textContent = pr[0];
      b.addEventListener('click', function () { fill(pr[1]); });
      presets.appendChild(b);
    });
    box.appendChild(presets);

    /* 目立つ輝点の案内。周期ノイズのように「どこを塗ればいいか」が
       決まっている画像では、初めて触る人にはその1点が見つけられない。
       機械のほうで見つけて印を出す（塗ったら印は消える）。
       実演で自分でさがしてもらいたいときのために、切れるようにしてある */
    var guide = document.createElement('label');
    guide.className = 'maskrow guide';
    var gcb = document.createElement('input');
    gcb.type = 'checkbox';
    gcb.checked = prefGet('maskGuide', true);
    gcb.addEventListener('change', function () {
      prefSet('maskGuide', gcb.checked);
      draw();
    });
    guide.appendChild(gcb);
    guide.appendChild(document.createTextNode(' 目立つ輝点に印をつける'));
    box.appendChild(guide);

    var hint = document.createElement('p');
    hint.className = 'maskhint';
    hint.textContent = 'ドラッグ＝遮る／右ドラッグ＝戻す。筆は点対称の位置にも同時に乗ります。' +
                       '黄色い破線は「周りから突出している輝点」で、塗ると消えます。';
    box.appendChild(hint);

    /* --- 格子との対応。U.fftGridIndex と同じ丸め方をする（DC を中心に左右対称） --- */
    function gridIndex(t) {
      var q = t * G;
      q = (q >= 0) ? Math.floor(q + 0.5) : -Math.floor(0.5 - q);
      var g = (G >> 1) + q;
      return ((g % G) + G) % G;
    }

    function fill(test) {
      var m = owner[def.key], gx, gy;
      for (gy = 0; gy < G; gy++) {
        var v = (gy - (G >> 1)) / G;
        for (gx = 0; gx < G; gx++) {
          var u = (gx - (G >> 1)) / G;
          var blocked = test ? test(u, v, Math.sqrt(u * u + v * v)) : false;
          m[gy * G + gx] = blocked ? 0 : 255;
        }
      }
      draw(); run();
    }

    /* 筆。周波数の面は端でつながっているので、はみ出したぶんは巻き戻す。
       実数画像のスペクトルは点対称なので、反対側にも必ず同じ丸を置く
       （片側だけ消すと逆変換の結果に虚部が残り、絵が壊れる） */
    function stamp(cx, cy, rad, val) {
      var m = owner[def.key], x, y;
      for (y = -rad; y <= rad; y++) {
        for (x = -rad; x <= rad; x++) {
          if (x * x + y * y > rad * rad) continue;
          var gx = (((cx + x) % G) + G) % G, gy = (((cy + y) % G) + G) % G;
          m[gy * G + gx] = val;
        }
      }
    }

    var painting = 0;                   /* 0=なし 1=遮る 2=戻す */

    function paintAt(e) {
      var r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var px = (e.clientX - r.left) / r.width * CW;
      var py = (e.clientY - r.top) / r.height * cv._ch;
      var gx = gridIndex((px - (CW >> 1)) / CW);
      var gy = gridIndex((py - (cv._ch >> 1)) / cv._ch);
      var rad = parseInt(br.value, 10);
      var val = (painting === 2) ? 255 : 0;
      stamp(gx, gy, rad, val);
      stamp((G - gx) % G, (G - gy) % G, rad, val);
      draw(); run();
    }

    cv.addEventListener('pointerdown', function (e) {
      painting = (e.button === 2) ? 2 : 1;
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
      paintAt(e);
    });
    cv.addEventListener('pointermove', function (e) { if (painting) paintAt(e); });
    cv.addEventListener('pointerup', function (e) {
      painting = 0;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    /* --- 描画 --- */
    function draw() {
      var src = state.srcImg;
      var ch = src ? Math.max(80, Math.min(240, Math.round(CW * src.height / src.width))) : 160;
      cv._ch = ch;

      var dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(CW * dpr); cv.height = Math.round(ch * dpr);
      cv.style.width = CW + 'px'; cv.style.height = ch + 'px';
      var g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#0b0f16'; g.fillRect(0, 0, CW, ch);
      if (!src) return;

      /* 敷くのは原画のスペクトル（輝度）。同じ画像なら作り直さない。
         画像が大きいと下敷きは出ない（js/fft.js の spectrumPreview を参照）。
         そのときは無地の上に塗ることになるので、その旨を出しておく */
      var bg = IL.spectrumPreview(src, CW, ch, 3, owner.edge || 'reflect');
      var img = new ImageData(CW, ch), d = img.data;
      var b = bg ? bg.data : new Uint8ClampedArray(CW * ch * 4);
      var m = owner[def.key], inv = !!owner.invert;
      var gxs = new Int32Array(CW), x, y;
      for (x = 0; x < CW; x++) gxs[x] = gridIndex((x - (CW >> 1)) / CW);

      for (y = 0; y < ch; y++) {
        var gy = gridIndex((y - (ch >> 1)) / ch) * G;
        for (x = 0; x < CW; x++) {
          var o = (y * CW + x) * 4;
          var pass = m[gy + gxs[x]] / 255;
          if (inv) pass = 1 - pass;
          var t = 1 - pass;
          d[o] = U.clamp8(b[o] + (170 - b[o] * 0.4) * t);
          d[o + 1] = U.clamp8(b[o + 1] * (1 - 0.6 * t));
          d[o + 2] = U.clamp8(b[o + 2] * (1 - 0.6 * t));
          d[o + 3] = 255;
        }
      }
      U.fftAxesOverlay(img);

      var off = document.createElement('canvas');
      off.width = CW; off.height = ch;
      off.getContext('2d').putImageData(img, 0, 0);
      g.drawImage(off, 0, 0);

      if (!bg) {
        g.font = '11px system-ui, sans-serif';
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.fillRect(0, ch - 34, CW, 34);
        g.fillStyle = '#ffd28a';
        g.fillText('画像が大きいので下敷きは省いています。', 8, ch - 20);
        g.fillText('ビューアを「スペクトル」にすると見られます。', 8, ch - 7);
        return;
      }
      if (gcb.checked) drawGuide(g, ch, m);
    }

    /* 輝点の案内。まだ遮っていない輝点にだけ丸をつけ、
       いちばん強いものには「ここ」と添える。塗れば印は消えるので、
       狙った場所を押さえられたかどうかがそのまま分かる。 */
    function drawGuide(g, ch, m) {
      var peaks = IL.spectrumPeaks(state.srcImg, owner.edge || 'reflect');
      if (!peaks.length) return;
      var inv = !!owner.invert, first = true;

      peaks.forEach(function (pk) {
        var gx = gridIndex(pk.u), gy = gridIndex(pk.v);
        var pass = m[gy * G + gx] / 255;
        if (inv) pass = 1 - pass;
        if (pass < 0.5) return;                    /* もう遮ってある */

        var x = CW / 2 + pk.u * CW, y = ch / 2 + pk.v * ch;
        g.save();
        g.strokeStyle = '#ffd54a';
        g.lineWidth = 1.5;
        g.setLineDash([3, 3]);
        g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
        g.restore();

        if (first) {
          first = false;
          /* 縁からはみ出さない側に文字を出す */
          var tx = (x < CW - 44) ? x + 10 : x - 34;
          var ty = (y > 14) ? y - 9 : y + 18;
          g.font = 'bold 11px system-ui, sans-serif';
          g.fillStyle = 'rgba(0,0,0,0.7)';
          g.fillRect(tx - 3, ty - 10, 28, 14);
          g.fillStyle = '#ffd54a';
          g.fillText('ここ', tx, ty);
        }
      });
    }

    spectrumWidget = draw;
    setTimeout(draw, 0);
    return box;
  }

  /* ---------------- 解説パネル ---------------- */

  function buildDoc(op) {
    var d = op.doc, host = $('explain');
    var html = '<h2>' + op.label + '</h2>';
    if (d.principle) {
      html += '<h3>原理</h3>';
      d.principle.split('\n\n').forEach(function (par) {
        html += '<p>' + par.replace(/\n/g, '<br>') + '</p>';
      });
    }
    if (d.formula) html += '<h3>式</h3><pre>' + d.formula + '</pre>';
    if (d.notes && d.notes.length) {
      html += '<h3>注意点・見どころ</h3><ul>';
      d.notes.forEach(function (n) { html += '<li>' + n + '</li>'; });
      html += '</ul>';
    }
    host.innerHTML = html;
    host.scrollTop = 0;
  }

  /* ---------------- カーソル情報 ---------------- */

  function onCursor(pos) {
    IL.hist.drawProfile($('profile'), state.srcImg, state.dstImg, pos);
    var el = $('pixel-readout');
    if (!el) return;
    if (!pos || !state.srcImg) { el.innerHTML = '<span>カーソル</span><b>—</b>'; return; }
    var i = (pos.y * state.srcImg.width + pos.x) * 4;
    var s = state.srcImg.data, t = state.dstImg ? state.dstImg.data : s;
    el.innerHTML = '<span>(' + pos.x + ', ' + pos.y + ')</span><b>' +
      s[i] + ',' + s[i + 1] + ',' + s[i + 2] + ' → ' +
      t[i] + ',' + t[i + 1] + ',' + t[i + 2] + '</b>';
  }

  /* ---------------- 起動 ---------------- */

  function init() {
    viewer = new IL.Viewer({
      wrap: $('viewer-wrap'),
      canvas: $('view'),
      loupe: $('loupe'),
      handle: $('split-handle'),
      onCursor: onCursor
    });

    buildOpList();

    /* サンプル選択 */
    var sel = $('sample-select');
    IL.samples.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.label;
      o.title = s.hint;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var s = IL.samples.filter(function (x) { return x.id === sel.value; })[0];
      setFullFromImageData(IL.buildSample(sel.value), 'サンプル：' + s.label);
      $('sample-hint').textContent = s.hint;
    });

    /* 画像を開く / ドラッグ＆ドロップ */
    $('btn-open').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      if (e.target.files[0]) loadFile(e.target.files[0]);
      e.target.value = '';
    });
    ['dragover', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    /* 作業解像度 */
    $('res-select').addEventListener('change', function (e) {
      state.maxSide = parseInt(e.target.value, 10);
      rebuildSource();
    });

    /* 表示モード */
    Array.prototype.forEach.call(document.querySelectorAll('input[name="vmode"]'), function (r) {
      r.addEventListener('change', function () {
        viewer.setMode(r.value);
        $('diff-gain-row').style.display = (r.value === 'diff') ? '' : 'none';
      });
    });
    $('diff-gain').addEventListener('input', function (e) {
      var g = parseFloat(e.target.value);
      $('diff-gain-val').textContent = '×' + g;
      viewer.setDiffGain(g);
    });

    /* 逐次表示（計算中の途中経過）。実演では入れて、作業中は切る想定 */
    state.progressive = prefGet('progressive', true);
    $('prog-on').checked = state.progressive;
    $('prog-on').addEventListener('change', function (e) {
      state.progressive = e.target.checked;
      prefSet('progressive', state.progressive);
      run();
    });

    /* ルーペ */
    $('loupe-on').addEventListener('change', function (e) {
      viewer.loupeOn = e.target.checked;
      if (!e.target.checked) $('loupe').style.display = 'none';
    });
    $('loupe-zoom').addEventListener('input', function (e) {
      viewer.loupeZoom = parseInt(e.target.value, 10);
      $('loupe-zoom-val').textContent = '×' + viewer.loupeZoom;
    });

    /* ヒストグラムのチャンネル */
    Array.prototype.forEach.call(document.querySelectorAll('input[name="hch"]'), function (r) {
      r.addEventListener('change', function () {
        state.histChannel = r.value;
        IL.hist.draw($('hist'), state.srcImg, state.dstImg, state.histChannel);
      });
    });

    /* 保存（PNG）。blob 経由にしておくと file:// でも確実に落とせる */
    $('btn-save').addEventListener('click', function () {
      if (!state.dstImg) return;
      var c = document.createElement('canvas');
      c.width = state.dstImg.width; c.height = state.dstImg.height;
      c.getContext('2d').putImageData(state.dstImg, 0, 0);
      /* 横並び比較の見出しは画素ではなくビューアに重ねて描いているので、
         そのままでは保存した PNG に入らない。ここで等倍で焼き込む
         （記事に貼るときに、どの面が何なのか分からないと使えないため） */
      if (viewer.overlay) viewer.drawOverlay(c.getContext('2d'), { scale: 1, ox: 0, oy: 0 });
      c.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'imagelab_' + state.opId + '_' + Date.now() + '.png';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      }, 'image/png');
    });

    /* キーボード：1〜4 で表示モード切り替え（画面共有中に手早く切り替える用） */
    document.addEventListener('keydown', function (e) {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      var map = { '1': 'split', '2': 'result', '3': 'source', '4': 'diff' };
      if (map[e.key]) {
        var r = document.querySelector('input[name="vmode"][value="' + map[e.key] + '"]');
        r.checked = true;
        r.dispatchEvent(new Event('change'));
      }
    });

    window.addEventListener('resize', function () {
      /* 下部の上限は画面の高さから決めているので、窓を縦に狭めたら測り直す */
      fitBottom();
      IL.hist.draw($('hist'), state.srcImg, state.dstImg, state.histChannel);
      IL.hist.drawProfile($('profile'), state.srcImg, state.dstImg, viewer.cursor);
    });

    /* 初期状態。
       URL の後ろに #op=canny&sample=geometry&mode=result のように付けると
       その状態で開く。同好会で見せたい状態をショートカットにしておける。 */
    var q = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var a = kv.split('=');
      if (a[0]) q[a[0]] = decodeURIComponent(a[1] || '');
    });

    var sampleId = IL.opById && q.sample && IL.samples.some(function (x) { return x.id === q.sample; })
      ? q.sample : 'lowcontrast';
    var smp = IL.samples.filter(function (x) { return x.id === sampleId; })[0];
    sel.value = sampleId;
    $('sample-hint').textContent = smp.hint;
    setFullFromImageData(IL.buildSample(sampleId), 'サンプル：' + smp.label);

    selectOp(IL.opById[q.op] ? q.op : 'none');

    if (q.mode) {
      var mr = document.querySelector('input[name="vmode"][value="' + q.mode + '"]');
      if (mr) { mr.checked = true; mr.dispatchEvent(new Event('change')); }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
