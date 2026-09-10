/* ImageLab — samples.js
 * 同梱サンプル画像を「コードで生成」する。
 * 外部画像を持たないので権利関係が発生せず、file:// で開いても
 * canvas が汚染（tainted）されない。
 * 手元の写真を使うときは、ヘッダの［画像を開く］か
 * 画面へのドラッグ＆ドロップで読み込む（samples/README.md 参照）。
 */
(function () {
  'use strict';
  var IL = (window.IL = window.IL || {});
  var U = IL.util;

  /* 再現性のある擬似乱数（mulberry32）。毎回同じ絵が出るようにする */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {
    var u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function blank(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function pixels(w, h, fn) {
    var img = new ImageData(w, h), d = img.data;
    for (var y = 0, j = 0; y < h; y++) {
      for (var x = 0; x < w; x++, j += 4) {
        var v = fn(x, y);
        if (typeof v === 'number') { d[j] = d[j + 1] = d[j + 2] = U.clamp8(v); }
        else { d[j] = U.clamp8(v[0]); d[j + 1] = U.clamp8(v[1]); d[j + 2] = U.clamp8(v[2]); }
        d[j + 3] = 255;
      }
    }
    return img;
  }

  var S = [];
  function def(id, label, hint, build) { S.push({ id: id, label: label, hint: hint, build: build }); }

  /* 1. グレースケール階段＋連続ランプ（点処理の基準） */
  def('step', 'グレー階段＋ランプ', 'トーンカーブ・ガンマの効きを段ごとに読み取れます', function () {
    var w = 640, h = 480;
    return pixels(w, h, function (x, y) {
      if (y < h * 0.40) {                          /* 16段の階段 */
        return Math.floor(x / w * 16) * 17;
      }
      if (y < h * 0.55) return x / (w - 1) * 255;  /* 連続ランプ */
      /* 中間調パッチ。各パッチ内に ±5 の市松を入れてあるので、
         ガンマやトーンカーブで「その明度でのコントラスト」の変化が見える */
      var col = Math.floor(x / w * 8);
      var row = Math.floor((y - h * 0.55) / (h * 0.45) * 2);
      var base = [16, 48, 80, 112, 144, 176, 208, 240][col] + (row === 1 ? 8 : 0);
      var chk = (((x >> 1) + (y >> 1)) & 1) ? 5 : -5;
      return base + chk;
    });
  });

  /* 2. 低コントラスト・暗部にディテール（ヒストグラム平坦化 / CLAHE 用） */
  def('lowcontrast', '低コントラスト（暗部にディテール）', 'ヒストグラム平坦化と CLAHE の差が一番出ます', function () {
    var w = 640, h = 480, rand = rng(20260901);
    var noise = new Float32Array(w * h);
    for (var i = 0; i < noise.length; i++) noise[i] = gauss(rand) * 2.2;
    return pixels(w, h, function (x, y) {
      var u = x / w, v = y / h;
      /* 大きな明暗のブロック（左上が暗く、右下が明るい） */
      var base = 60 + 90 * (0.35 * u + 0.65 * v);
      /* 小さなディテール。振幅が小さいので素のままではほとんど見えない */
      var det = 7 * Math.sin(x * 0.13) * Math.sin(y * 0.11)
              + 5 * Math.sin((x + y) * 0.045)
              + 6 * ((((x / 32) | 0) + ((y / 32) | 0)) % 2 ? 1 : -1) * (v > 0.5 ? 1 : 0.3);
      /* 局所的に明るい窓。大域的な平坦化だとここが白飛びしやすい */
      var dx = x - w * 0.78, dy = y - h * 0.24;
      if (dx * dx / (110 * 110) + dy * dy / (70 * 70) < 1) base += 55;
      /* 全体を狭い range に押し込めて低コントラストにする */
      var g = base + det + noise[y * w + x];
      return 40 + (g - 20) * 0.72;
    });
  });

  /* 3. 幾何図形（エッジ検出用。エッジの向きが一通りそろう） */
  def('geometry', '幾何図形（直線・円・斜線）', 'Sobel の勾配方向表示や Canny の段階表示に向きます', function () {
    var w = 640, h = 480, c = blank(w, h), g = c.getContext('2d');
    var i, r;
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1c1c1c';
    g.fillRect(60, 60, 150, 110);                                    /* 矩形 */
    g.beginPath(); g.arc(330, 115, 62, 0, Math.PI * 2); g.fill();    /* 円 */
    g.beginPath(); g.moveTo(470, 60); g.lineTo(580, 175);            /* 三角形 */
    g.lineTo(430, 175); g.closePath(); g.fill();
    g.strokeStyle = '#1c1c1c';                                       /* 斜線の束（角度と太さを振る） */
    for (i = 0; i < 9; i++) {
      g.lineWidth = 1 + i * 0.35;
      g.beginPath(); g.moveTo(50 + i * 26, 230); g.lineTo(120 + i * 40, 450); g.stroke();
    }
    g.lineWidth = 2;                                                 /* 同心円 */
    for (r = 12; r < 100; r += 14) {
      g.beginPath(); g.arc(500, 350, r, 0, Math.PI * 2); g.stroke();
    }
    g.fillStyle = '#8a8a8a';                                         /* 弱いコントラストの図形 */
    g.fillRect(300, 250, 120, 90);                                   /* 閾値の効きを見るため */
    g.fillStyle = '#b4b4b4';
    g.fillRect(300, 350, 120, 90);
    return g.getImageData(0, 0, w, h);
  });

  /* 4. ゾーンプレート（外側ほど高周波。平滑化とエイリアシングの教材） */
  def('zone', 'ゾーンプレート', '中心から外へ周波数が上がります。ぼかしの効きが半径で読めます', function () {
    var w = 512, h = 512, cx = w / 2, cy = h / 2, k = 0.0016;
    return pixels(w, h, function (x, y) {
      var dx = x - cx, dy = y - cy;
      return 127.5 + 120 * Math.cos(k * (dx * dx + dy * dy));
    });
  });

  /* 5. ソルト＆ペッパー（メディアンの独壇場） */
  def('saltpepper', 'ソルト＆ペッパーノイズ', 'メディアンとガウシアンの差が決定的に出ます', function () {
    var w = 640, h = 480, rand = rng(7), rate = 0.06;
    return pixels(w, h, function (x, y) {
      var r = rand();
      if (r < rate / 2) return 0;
      if (r < rate) return 255;
      var band = 60 + 130 * (y / h);
      var stripe = (x % 96 < 48) ? 28 : -28;
      var ring = 22 * Math.sin(Math.sqrt((x - 470) * (x - 470) + (y - 150) * (y - 150)) * 0.09);
      return band + stripe * 0.6 + ring;
    });
  });

  /* 6. ガウシアンノイズ＋段差エッジ（バイラテラルの「エッジを保つ」を見る） */
  def('gaussnoise', 'ガウシアンノイズ＋段差', 'バイラテラルがエッジを残してノイズだけ削るのが分かります', function () {
    var w = 640, h = 480, rand = rng(1234);
    return pixels(w, h, function (x, y) {
      var base;
      if (x < w * 0.33) base = 70;
      else if (x < w * 0.66) base = 150 + 40 * (y / h);   /* なだらかな勾配 */
      else base = 215;
      if (y > h * 0.62) base = 255 - base;                 /* 下半分は反転して段差を増やす */
      return base + gauss(rand) * 15;
    });
  });

  /* 7. ぼけた細線・格子（アンシャープマスクの練習台） */
  def('fineline', 'ぼけた細線・格子', 'アンシャープマスクの量と半径の効きが見えます', function () {
    var w = 640, h = 480, c = blank(w, h), g = c.getContext('2d');
    var i, x, y;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#202020'; g.lineWidth = 1;
    for (i = 40; i < 300; i += 8) { g.beginPath(); g.moveTo(i, 40); g.lineTo(i, 200); g.stroke(); }
    for (i = 40; i < 200; i += 8) { g.beginPath(); g.moveTo(40, i); g.lineTo(300, i); g.stroke(); }
    g.fillStyle = '#202020';
    for (i = 0; i < 7; i++) {                       /* 線幅の違う棒（解像力の目安） */
      g.fillRect(360 + i * 30, 50, i + 1, 150);
    }
    for (i = 0; i < 60; i++) {                      /* 文字くらいの大きさの小片 */
      x = 50 + (i % 12) * 46; y = 260 + Math.floor(i / 12) * 44;
      g.fillRect(x, y, 3 + (i % 4), 14);
      g.fillRect(x, y + (i % 3) * 5, 12, 3);
    }
    var img = g.getImageData(0, 0, w, h);
    /* σ=1.6 でぼかしてから渡す。アンシャープで戻す対象になる */
    var pl = U.splitPlanes(img);
    return U.mergePlanes(
      U.gaussianBlurPlane(pl[0], w, h, 1.6),
      U.gaussianBlurPlane(pl[1], w, h, 1.6),
      U.gaussianBlurPlane(pl[2], w, h, 1.6), w, h);
  });

  /* 8. ジーメンススター（解像力チャート） */
  def('siemens', 'ジーメンススター', '中心へ向かうほど細かくなります。ぼけの量を半径で測れます', function () {
    var w = 512, h = 512, cx = w / 2, cy = h / 2, spokes = 36;
    return pixels(w, h, function (x, y) {
      var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy);
      if (r > 230) return 235;
      if (r < 8) return 128;
      return 127.5 + 120 * Math.cos(Math.atan2(dy, dx) * spokes);
    });
  });

  /* 9. カラーチャート（「輝度のみ」と「RGB個別」の違いを見るため） */
  def('colorbars', 'カラーバー＋彩度グラデ', '点処理の対象（輝度のみ / RGB個別）で結果がどう変わるか比べられます', function () {
    var w = 640, h = 480;
    var bars = [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0],
                [192, 0, 192], [192, 0, 0], [0, 0, 192], [24, 24, 24]];
    return pixels(w, h, function (x, y) {
      if (y < h * 0.45) return bars[Math.min(7, Math.floor(x / w * 8))];
      if (y < h * 0.60) {                       /* 彩度グラデ（赤→灰） */
        var t = x / (w - 1);
        return [200, 60 + 140 * t, 60 + 140 * t];
      }
      /* 肌色〜空色の緩いグラデ（自然画像に近い当たりを作る） */
      var u = x / w, v = (y - h * 0.6) / (h * 0.4);
      return [150 + 80 * u - 30 * v, 120 + 40 * u + 20 * v, 100 + 10 * u + 110 * v];
    });
  });

  /* 10. 周期ノイズ（周波数領域の本命。空間フィルタでは絵を壊さずに取れない） */
  def('periodic', '周期ノイズ（斜め縞）', 'スペクトルの輝点1組を潰すと縞だけ消えます。ノッチ／スペクトルマスク用', function () {
    var w = 640, h = 480, c = blank(w, h), g = c.getContext('2d');
    var i, x, y;

    /* 下地：なだらかな明暗と、輪郭のはっきりした図形をいくつか。
       縞を消したあとに「絵が壊れていない」ことが読み取れる中身にしてある */
    var grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#5a6474'); grad.addColorStop(1, '#c9d2dc');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2a2f38';
    g.beginPath(); g.arc(180, 170, 78, 0, Math.PI * 2); g.fill();
    g.fillRect(380, 90, 170, 120);
    g.fillStyle = '#eef2f6';
    g.beginPath(); g.moveTo(300, 430); g.lineTo(420, 250); g.lineTo(540, 430); g.closePath(); g.fill();
    g.fillRect(70, 300, 150, 40);
    g.fillStyle = '#8d96a2';
    for (i = 0; i < 6; i++) g.fillRect(70 + i * 26, 370, 12, 80);
    var img = g.getImageData(0, 0, w, h), d = img.data;

    /* 縞：周波数 (u₀, v₀) = (0.18, 0.09) サイクル/画素。
       スペクトルでは中心から離れた位置に輝点が1組だけ立つ。
       振幅 30 は、目にはっきり見えて下地は読み取れる、という兼ね合いで決めた */
    var u0 = 0.18, v0 = 0.09, amp = 30;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var n = amp * Math.sin(2 * Math.PI * (u0 * x + v0 * y));
        var j = (y * w + x) * 4;
        d[j] = U.clamp8(d[j] + n); d[j + 1] = U.clamp8(d[j + 1] + n); d[j + 2] = U.clamp8(d[j + 2] + n);
      }
    }
    return img;
  });

  IL.samples = S;
  IL.buildSample = function (id) {
    for (var i = 0; i < S.length; i++) if (S[i].id === id) return S[i].build();
    return null;
  };
})();
