/* ImageLab — core.js
 * 共通ユーティリティ。ImageData と Float32Array プレーンの相互変換、
 * 畳み込み、ヒストグラムなど、各処理から使い回す部品を置く。
 *
 * file:// で直接開けるようにするため ES Modules は使わず、
 * グローバル名前空間 IL にぶら下げる classic script にしている。
 */
(function () {
  'use strict';
  var IL = (window.IL = window.IL || {});
  var U = (IL.util = {});

  /* ---------- 基本 ---------- */

  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.clamp8 = function (v) { return v < 0 ? 0 : (v > 255 ? 255 : v); };

  /* reflect101 境界処理：|cba|abcd|dcb| （端の画素を重複させない鏡映） */
  U.mir = function (i, n) {
    if (n === 1) return 0;
    while (i < 0 || i >= n) {
      if (i < 0) i = -i;
      if (i >= n) i = 2 * n - 2 - i;
    }
    return i;
  };

  U.newImageData = function (w, h) { return new ImageData(w, h); };

  U.cloneImageData = function (src) {
    return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  };

  /* ---------- プレーン変換 ---------- */

  /* ImageData → [R, G, B] の Float32Array（値域 0..255、途中計算のため float） */
  U.splitPlanes = function (img) {
    var n = img.width * img.height, d = img.data;
    var r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) { r[i] = d[j]; g[i] = d[j + 1]; b[i] = d[j + 2]; }
    return [r, g, b];
  };

  U.mergePlanes = function (r, g, b, w, h) {
    var out = new ImageData(w, h), d = out.data, n = w * h;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      d[j] = U.clamp8(r[i]); d[j + 1] = U.clamp8(g[i]); d[j + 2] = U.clamp8(b[i]); d[j + 3] = 255;
    }
    return out;
  };

  /* 輝度 Y = 0.299R + 0.587G + 0.114B（ITU-R BT.601） */
  U.RW = 0.299; U.GW = 0.587; U.BW = 0.114;

  U.toGrayPlane = function (img) {
    var n = img.width * img.height, d = img.data, p = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      p[i] = U.RW * d[j] + U.GW * d[j + 1] + U.BW * d[j + 2];
    }
    return p;
  };

  U.grayToImageData = function (p, w, h) {
    var out = new ImageData(w, h), d = out.data, n = w * h;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var v = U.clamp8(p[i]);
      d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255;
    }
    return out;
  };

  /* ---------- LUT 適用 ---------- */

  /* lut: length 256 の配列。mode 'rgb' は各チャンネル独立、
   * 'luma' は輝度だけを変換して色比を保つ（色相のねじれを避ける）。 */
  U.applyLUT = function (img, lut, mode) {
    var w = img.width, h = img.height, n = w * h;
    var s = img.data, out = new ImageData(w, h), d = out.data;
    var i, j;
    if (mode === 'rgb') {
      for (i = 0, j = 0; i < n; i++, j += 4) {
        d[j] = lut[s[j]]; d[j + 1] = lut[s[j + 1]]; d[j + 2] = lut[s[j + 2]]; d[j + 3] = 255;
      }
    } else {
      for (i = 0, j = 0; i < n; i++, j += 4) {
        var r = s[j], g = s[j + 1], b = s[j + 2];
        var y = U.RW * r + U.GW * g + U.BW * b;
        var yi = y < 0 ? 0 : (y > 255 ? 255 : Math.round(y));
        var y2 = lut[yi];
        if (y < 1) {
          /* 黒つぶれ付近は比率が発散するので加算で逃がす */
          var add = y2 - y;
          d[j] = U.clamp8(r + add); d[j + 1] = U.clamp8(g + add); d[j + 2] = U.clamp8(b + add);
        } else {
          var k = y2 / y;
          d[j] = U.clamp8(r * k); d[j + 1] = U.clamp8(g * k); d[j + 2] = U.clamp8(b * k);
        }
        d[j + 3] = 255;
      }
    }
    return out;
  };

  U.identityLUT = function () {
    var lut = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) lut[i] = i;
    return lut;
  };

  /* ---------- カーネル ---------- */

  U.gaussianKernel1d = function (sigma) {
    if (sigma < 0.05) return new Float32Array([1]);
    var r = Math.max(1, Math.ceil(sigma * 3));
    var k = new Float32Array(2 * r + 1), sum = 0;
    for (var i = -r; i <= r; i++) {
      var v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k[i + r] = v; sum += v;
    }
    for (var m = 0; m < k.length; m++) k[m] /= sum;
    return k;
  };

  U.boxKernel1d = function (radius) {
    var len = 2 * radius + 1, k = new Float32Array(len);
    for (var i = 0; i < len; i++) k[i] = 1 / len;
    return k;
  };

  /* 分離可能畳み込み：横 → 縦。O(w*h*(kx+ky)) で済む。
   *
   * 速度のために「縁」と「内側」を分けて回している。
   * 全画素で U.mir()（while ループ入り）を呼ぶと、σ=2 でも1画素あたり
   * 26回の関数呼び出しになり、そこが処理時間の大半を占めてしまう。
   * 鏡映が要るのは縁だけなので、内側は添字を直接足して回す。 */
  U.convolveSeparable = function (p, w, h, kx, ky) {
    var klx = kx.length, kly = ky.length;
    var rx = (klx - 1) >> 1, ry = (kly - 1) >> 1;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var x, y, k, s, row, base;

    /* --- 横方向 --- */
    var xLo = Math.min(rx, w), xHi = Math.max(xLo, w - rx);
    for (y = 0; y < h; y++) {
      row = y * w;
      for (x = 0; x < xLo; x++) {                 /* 左の縁 */
        s = 0;
        for (k = -rx; k <= rx; k++) s += p[row + U.mir(x + k, w)] * kx[k + rx];
        tmp[row + x] = s;
      }
      for (x = xLo; x < xHi; x++) {               /* 内側：境界判定なし */
        s = 0; base = row + x - rx;
        for (k = 0; k < klx; k++) s += p[base + k] * kx[k];
        tmp[row + x] = s;
      }
      for (x = xHi; x < w; x++) {                 /* 右の縁 */
        s = 0;
        for (k = -rx; k <= rx; k++) s += p[row + U.mir(x + k, w)] * kx[k + rx];
        tmp[row + x] = s;
      }
    }

    /* --- 縦方向。行ごとに走らせてキャッシュに乗せる --- */
    var yLo = Math.min(ry, h), yHi = Math.max(yLo, h - ry);
    for (y = 0; y < yLo; y++) {                   /* 上の縁 */
      row = y * w;
      for (x = 0; x < w; x++) {
        s = 0;
        for (k = -ry; k <= ry; k++) s += tmp[U.mir(y + k, h) * w + x] * ky[k + ry];
        out[row + x] = s;
      }
    }
    for (y = yLo; y < yHi; y++) {                 /* 内側 */
      row = y * w;
      base = row - ry * w;
      for (x = 0; x < w; x++) {
        s = 0;
        for (k = 0; k < kly; k++) s += tmp[base + k * w + x] * ky[k];
        out[row + x] = s;
      }
    }
    for (y = yHi; y < h; y++) {                   /* 下の縁 */
      row = y * w;
      for (x = 0; x < w; x++) {
        s = 0;
        for (k = -ry; k <= ry; k++) s += tmp[U.mir(y + k, h) * w + x] * ky[k + ry];
        out[row + x] = s;
      }
    }
    return out;
  };

  /* 非分離の一般畳み込み（3x3 など小さい窓向け）。
   * これも内側は境界判定を外してある。 */
  U.convolve2d = function (p, w, h, kernel, kw, kh) {
    var rx = (kw - 1) >> 1, ry = (kh - 1) >> 1;
    var out = new Float32Array(w * h);
    var x, y, i, j, s, yy;
    for (y = 0; y < h; y++) {
      var inRow = (y >= ry && y < h - ry);
      for (x = 0; x < w; x++) {
        s = 0;
        if (inRow && x >= rx && x < w - rx) {
          for (j = -ry; j <= ry; j++) {
            yy = (y + j) * w + x;
            for (i = -rx; i <= rx; i++) s += p[yy + i] * kernel[(j + ry) * kw + (i + rx)];
          }
        } else {
          for (j = -ry; j <= ry; j++) {
            yy = U.mir(y + j, h) * w;
            for (i = -rx; i <= rx; i++) s += p[yy + U.mir(x + i, w)] * kernel[(j + ry) * kw + (i + rx)];
          }
        }
        out[y * w + x] = s;
      }
    }
    return out;
  };

  U.gaussianBlurPlane = function (p, w, h, sigma) {
    if (sigma < 0.05) return p.slice();
    var k = U.gaussianKernel1d(sigma);
    return U.convolveSeparable(p, w, h, k, k);
  };

  /* ---------- ヒストグラム ---------- */

  U.histogram256 = function (plane) {
    var hist = new Uint32Array(256);
    for (var i = 0; i < plane.length; i++) {
      var v = plane[i];
      hist[v < 0 ? 0 : (v > 255 ? 255 : Math.round(v))]++;
    }
    return hist;
  };

  U.histogramRGB = function (img) {
    var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256),
        hy = new Uint32Array(256);
    var d = img.data, n = img.width * img.height;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      hr[d[j]]++; hg[d[j + 1]]++; hb[d[j + 2]]++;
      hy[Math.round(U.RW * d[j] + U.GW * d[j + 1] + U.BW * d[j + 2])]++;
    }
    return { r: hr, g: hg, b: hb, y: hy };
  };

  /* ---------- 表示補助 ---------- */

  /* Float32 プレーンを 0..255 に正規化して可視化（min/max を自動で取る） */
  U.normalizeToImageData = function (p, w, h) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < p.length; i++) { if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
    var span = hi - lo || 1;
    var q = new Float32Array(p.length);
    for (i = 0; i < p.length; i++) q[i] = (p[i] - lo) * 255 / span;
    return U.grayToImageData(q, w, h);
  };

  /* ---------- ノイズ ----------
   *
   * 乱数を「順番に引く」形（mulberry32 のような状態つき生成器）にすると、
   * 行帯に切って別々のワーカーで計算したときに、帯ごとに列が食い違って
   * 継ぎ目が出てしまう。そこで座標そのものから値を作る「位置ハッシュ」にしている。
   * どこから計算しても同じ画素には必ず同じノイズが乗るので、
   * ノイズ付加はそのまま複数コアで分担できる。 */

  /* 座標と種から 32bit を作る。整数の掛け算は Math.imul で 32bit に丸める */
  U.hash32 = function (x, y, s) {
    var a = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
    a = Math.imul(a ^ (a >>> 13), 1274126177);
    a = Math.imul(a ^ (a >>> 16), 2246822519);
    return (a ^ (a >>> 15)) >>> 0;
  };

  /* 0 < u < 1 の一様乱数（0 と 1 を含めない。log を取るので 0 が困る） */
  U.hashUnit = function (x, y, s) {
    return (U.hash32(x, y, s) + 1) / 4294967297;
  };

  /* 標準正規分布。Box-Muller 法で一様乱数2つから作る */
  U.hashGauss = function (x, y, s) {
    var u = U.hashUnit(x, y, s), v = U.hashUnit(x, y, s + 8191);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  /* ポアソン分布の乱数。λ が小さいうちは Knuth の方法（一様乱数を掛けていって
     e^-λ を下回るまでの回数）、大きくなるとループが伸びるので正規近似に切り替える。
     ショットノイズ＝光子の到着数のばらつきなので、これが実体そのもの。 */
  U.hashPoisson = function (lam, x, y, s) {
    if (lam > 40) {
      var v = Math.round(lam + Math.sqrt(lam) * U.hashGauss(x, y, s + 4093));
      return v < 0 ? 0 : v;
    }
    var L = Math.exp(-lam), k = 0, p = 1;
    while (p > L && k < 400) {
      p *= U.hashUnit(x, y, s + 65536 + k);
      k++;
    }
    return k - 1;
  };

  /* ノイズを乗せた行帯 [y0, y1) を返す。
   * p = { kind:'gauss'|'sp'|'shot'|'periodic', sigma, prob, peak, seed, color,
   *       pperiod, pangle, pamp }
   *   gauss    … 標準偏差 sigma 階調の正規ノイズを加算（センサの読み出しノイズ）
   *   sp       … 確率 prob で 0 か 255 に置き換え（伝送エラー・欠陥画素）
   *   shot     … 明るさを peak 個の光子に見立ててポアソン分布で引き直す（光子数のゆらぎ）
   *   periodic … 斜めの縞を加算（スキャンの網点・電気的な干渉。周波数領域で消す題材）
   * color を切ると3チャンネルに同じ値が乗る（モノクロのノイズに見える）。 */
  U.noiseBand = function (src, p, y0, y1) {
    var w = src.width, sd = src.data;
    var out = new ImageData(w, y1 - y0), d = out.data;
    var seed = (p.seed | 0) * 7919;
    var x, y, ch, o, q, v, u, s;

    /* 周期ノイズの (u₀, v₀)。周期と向きから作って、ループの外で1回だけ求める。
       乱数を使わないので種は効かない（同じ座標には必ず同じ値が乗る＝帯に切っても継ぎ目なし）。
       **斜めであることが要**：縦縞・横縞はスペクトルの十字の上に乗ってしまい、
       輝点さがし（js/fft.js の findPeaks）が十字を見ないので狙えなくなる。 */
    var pu = 0, pv = 0, pamp = 0, th, per;
    if (p.kind === 'periodic') {
      th = (p.pangle === undefined ? 27 : p.pangle) * Math.PI / 180;
      per = (p.pperiod === undefined ? 5 : p.pperiod);
      pamp = (p.pamp === undefined ? 30 : p.pamp);
      pu = Math.cos(th) / per;
      pv = Math.sin(th) / per;
    }

    for (y = y0; y < y1; y++) {
      for (x = 0; x < w; x++) {
        q = (y * w + x) * 4;
        o = ((y - y0) * w + x) * 4;
        if (p.kind === 'sp') {
          /* 白か黒に飛ばす。色ノイズを切ってあるときは3チャンネルまとめて飛ばす */
          if (p.color) {
            for (ch = 0; ch < 3; ch++) {
              u = U.hashUnit(x, y, seed + ch * 131);
              d[o + ch] = (u < p.prob) ? (U.hashUnit(x, y, seed + 977 + ch * 131) < 0.5 ? 0 : 255)
                                       : sd[q + ch];
            }
          } else {
            u = U.hashUnit(x, y, seed);
            if (u < p.prob) {
              v = U.hashUnit(x, y, seed + 977) < 0.5 ? 0 : 255;
              d[o] = v; d[o + 1] = v; d[o + 2] = v;
            } else {
              d[o] = sd[q]; d[o + 1] = sd[q + 1]; d[o + 2] = sd[q + 2];
            }
          }
        } else if (p.kind === 'shot') {
          for (ch = 0; ch < 3; ch++) {
            s = p.color ? seed + ch * 131 : seed;
            v = sd[q + ch] / 255 * p.peak;
            d[o + ch] = U.clamp8(U.hashPoisson(v, x, y, s) / p.peak * 255);
          }
        } else if (p.kind === 'periodic') {
          /* 3チャンネルに同じだけ足す（色ではなく明暗の縞になる）。
             色ごとに位相をずらすことはしない — 消すのが目的の題材なので、
             スペクトルに立つ輝点を1組に保つほうが分かりやすい */
          v = pamp * Math.sin(2 * Math.PI * (pu * x + pv * y));
          d[o] = U.clamp8(sd[q] + v);
          d[o + 1] = U.clamp8(sd[q + 1] + v);
          d[o + 2] = U.clamp8(sd[q + 2] + v);
        } else {
          if (p.color) {
            for (ch = 0; ch < 3; ch++) {
              d[o + ch] = U.clamp8(sd[q + ch] + p.sigma * U.hashGauss(x, y, seed + ch * 131));
            }
          } else {
            v = p.sigma * U.hashGauss(x, y, seed);
            d[o] = U.clamp8(sd[q] + v);
            d[o + 1] = U.clamp8(sd[q + 1] + v);
            d[o + 2] = U.clamp8(sd[q + 2] + v);
          }
        }
        d[o + 3] = 255;
      }
    }
    return out;
  };

  /* ---------- 画質の物差し ---------- */

  /* PSNR（ピーク信号対雑音比、dB）。RGB 3チャンネルの平均二乗誤差から出す。
     完全一致のときは Infinity を返す（表示側で「∞」に置き換える）。 */
  U.psnr = function (a, b) {
    var da = a.data, db = b.data, n = a.width * a.height;
    var i, j, e, se = 0;
    for (i = 0, j = 0; i < n; i++, j += 4) {
      e = da[j] - db[j]; se += e * e;
      e = da[j + 1] - db[j + 1]; se += e * e;
      e = da[j + 2] - db[j + 2]; se += e * e;
    }
    var mse = se / (n * 3);
    if (mse <= 0) return Infinity;
    return 10 * Math.log(255 * 255 / mse) / Math.LN10;
  };

  /* mask[i] が 1 の画素だけで測る PSNR。
     幾何変換の往復で使う。変換で画像の外へ出た画素は「情報がそもそも無い」ので、
     そこまで数えると補間の損ではなく隅の黒さを測ることになってしまう。
     数えた画素数も返す（どれだけの範囲で比べたのかを画面に出すため）。 */
  U.psnrMasked = function (a, b, mask) {
    var da = a.data, db = b.data, n = a.width * a.height;
    var i, j, e, se = 0, cnt = 0;
    for (i = 0, j = 0; i < n; i++, j += 4) {
      if (!mask[i]) continue;
      e = da[j] - db[j]; se += e * e;
      e = da[j + 1] - db[j + 1]; se += e * e;
      e = da[j + 2] - db[j + 2]; se += e * e;
      cnt++;
    }
    if (cnt === 0) return { psnr: 0, count: 0 };
    var mse = se / (cnt * 3);
    return { psnr: mse <= 0 ? Infinity : 10 * Math.log(255 * 255 / mse) / Math.LN10,
             count: cnt };
  };

  /* SSIM（構造的類似度、0〜1）。輝度で計算する。
   *
   * 原典（Wang et al. 2004）どおり、11×11・σ=1.5 のガウシアン窓で
   * 局所の平均・分散・共分散を取り、画素ごとの類似度を平均する。
   * 窓を掛ける計算は「x, x², xy をそれぞれぼかす」形に書き換えられるので、
   * 分離可能ガウシアンを5回かけるだけで済む（窓を素直に回すと O(N·121)）。
   *
   * PSNR は誤差の大きさしか見ないが、SSIM は「明るさ・コントラスト・模様の並び方」を
   * 分けて見るので、人の目の印象に近い。ぼかしすぎた画像は PSNR が良くても
   * SSIM が落ちる、という形で差が出る。 */
  /* 基準画像の側だけを先に作る。1枚の原画に対して何枚も比べるとき
     （3手法の比較など）、この部分は使い回せる */
  U.ssimRef = function (a) {
    var w = a.width, h = a.height, n = w * h, i;
    var x = U.toGrayPlane(a), xx = new Float32Array(n);
    for (i = 0; i < n; i++) xx[i] = x[i] * x[i];
    return { w: w, h: h, x: x,
             mx: U.gaussianBlurPlane(x, w, h, 1.5),
             sxx: U.gaussianBlurPlane(xx, w, h, 1.5) };
  };

  U.ssimAgainst = function (ref, b) {
    var w = ref.w, h = ref.h, n = w * h, i;
    var x = ref.x, y = U.toGrayPlane(b);
    var yy = new Float32Array(n), xy = new Float32Array(n);
    for (i = 0; i < n; i++) { yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }

    var mx = ref.mx, sxx = ref.sxx;
    var my = U.gaussianBlurPlane(y, w, h, 1.5);
    var syy = U.gaussianBlurPlane(yy, w, h, 1.5);
    var sxy = U.gaussianBlurPlane(xy, w, h, 1.5);

    /* C1 = (0.01·255)², C2 = (0.03·255)²。分母が 0 に落ちるのを防ぐための下駄 */
    var C1 = 6.5025, C2 = 58.5225, sum = 0;
    for (i = 0; i < n; i++) {
      var ux = mx[i], uy = my[i];
      var vx = sxx[i] - ux * ux, vy = syy[i] - uy * uy, vxy = sxy[i] - ux * uy;
      sum += ((2 * ux * uy + C1) * (2 * vxy + C2)) /
             ((ux * ux + uy * uy + C1) * (vx + vy + C2));
    }
    return sum / n;
  };

  U.ssim = function (a, b) { return U.ssimAgainst(U.ssimRef(a), b); };

  /* ---------- 幾何変換：逆写像でのサンプリング ----------
   *
   * 画像を回したり歪ませたりするときは、「入力の画素をどこへ飛ばすか」ではなく
   * 「出力の画素がどこを読むか」で考える（逆写像）。順方向に飛ばすと、
   * 行き先が飛び飛びになって隙間が空いたり、2つが同じ場所に落ちたりする。
   * 逆写像なら出力の全画素がちょうど1回ずつ埋まる。
   *
   * 読む場所は小数になるので、そこで補間が要る。ここに置いた3種類
   * （最近傍／バイリニア／バイキュービック）が、そのまま速さと画質の階段になる。 */

  /* 添字を画像の中に入れる。'zero' は「外は黒」なので、外なら -1 を返す */
  U.edgeIndex = function (i, n, edge) {
    if (i >= 0 && i < n) return i;
    if (edge === 'clamp') return i < 0 ? 0 : n - 1;
    if (edge === 'mirror') return U.mir(i, n);
    return -1;
  };

  /* Catmull-Rom（a = -0.5）の重み。i は -1, 0, 1, 2 */
  U.cubicWeight = function (t, i) {
    var a = -0.5, x = t - i;
    if (x < 0) x = -x;
    if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
    if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
    return 0;
  };

  /* (x, y) を実数座標として読み、out[0..2] に RGB を入れる。
     out は呼ぶ側が使い回す長さ3以上の配列（1画素ごとに作ると遅い）。
     mode: 'nearest' | 'bilinear' | 'bicubic'
     edge: 'zero'（外は黒） | 'clamp'（端を伸ばす） | 'mirror'（鏡映） */
  U.sampleImage = function (img, x, y, mode, edge, out) {
    var w = img.width, h = img.height, d = img.data;
    var r = 0, g = 0, b = 0;
    var x0, y0, fx, fy, i, j, ix, iy, wx, wy, ww, o;

    if (mode === 'nearest') {
      ix = U.edgeIndex(Math.round(x), w, edge);
      iy = U.edgeIndex(Math.round(y), h, edge);
      if (ix >= 0 && iy >= 0) {
        o = (iy * w + ix) * 4; r = d[o]; g = d[o + 1]; b = d[o + 2];
      }
      out[0] = r; out[1] = g; out[2] = b;
      return;
    }

    x0 = Math.floor(x); y0 = Math.floor(y);
    fx = x - x0; fy = y - y0;

    if (mode === 'bicubic') {
      for (j = -1; j <= 2; j++) {
        wy = U.cubicWeight(fy, j);
        if (wy === 0) continue;
        iy = U.edgeIndex(y0 + j, h, edge);
        if (iy < 0) continue;
        for (i = -1; i <= 2; i++) {
          wx = U.cubicWeight(fx, i);
          if (wx === 0) continue;
          ix = U.edgeIndex(x0 + i, w, edge);
          if (ix < 0) continue;
          ww = wx * wy; o = (iy * w + ix) * 4;
          r += d[o] * ww; g += d[o + 1] * ww; b += d[o + 2] * ww;
        }
      }
    } else {
      for (j = 0; j <= 1; j++) {
        wy = j ? fy : 1 - fy;
        if (wy === 0) continue;
        iy = U.edgeIndex(y0 + j, h, edge);
        if (iy < 0) continue;
        for (i = 0; i <= 1; i++) {
          wx = i ? fx : 1 - fx;
          if (wx === 0) continue;
          ix = U.edgeIndex(x0 + i, w, edge);
          if (ix < 0) continue;
          ww = wx * wy; o = (iy * w + ix) * 4;
          r += d[o] * ww; g += d[o + 1] * ww; b += d[o + 2] * ww;
        }
      }
    }
    out[0] = r; out[1] = g; out[2] = b;
  };

  /* タップ数＝出力の1画素を作るのに、元の絵から何点読むか。
     最近傍は一番近い1点、バイリニアは 2×2 の4点、バイキュービックは 4×4 の16点。
     op.cost の見積りと、画面の「補間」欄に使う */
  U.interpTaps = function (mode) {
    return mode === 'nearest' ? 1 : (mode === 'bicubic' ? 16 : 4);
  };

  /* 画面に出す補間の名前。上のタップ数と対で使う */
  U.interpName = function (mode) {
    return mode === 'nearest' ? '最近傍' : (mode === 'bicubic' ? 'バイキュービック' : 'バイリニア');
  };

  /* ---------- タイル合成 ---------- */

  /* 画像を 2×2 の箱平均で半分に縮める。横並び比較のタイルを作るのに使う。
     canvas が使えない Worker の中でも動かす必要があるので手で書いている。 */
  U.halveImage = function (img) {
    var w = img.width, h = img.height;
    var ow = w >> 1, oh = h >> 1;
    var out = new ImageData(ow, oh), s = img.data, d = out.data;
    var x, y, ch, o, a, b, c2, e;
    for (y = 0; y < oh; y++) {
      for (x = 0; x < ow; x++) {
        o = (y * ow + x) * 4;
        a = ((2 * y) * w + 2 * x) * 4;
        b = a + 4;
        c2 = a + w * 4;
        e = c2 + 4;
        for (ch = 0; ch < 3; ch++) {
          d[o + ch] = (s[a + ch] + s[b + ch] + s[c2 + ch] + s[e + ch] + 2) >> 2;
        }
        d[o + 3] = 255;
      }
    }
    return out;
  };

  /* 4枚を 2×2 に貼り合わせて1枚にする。並びは [左上, 右上, 左下, 右下]。
     出力は入力と同じ w×h（各面は半分の解像度）。奇数のときは右端・下端が余るので
     そこは 0 のまま残さず、境目の線で埋める。 */
  U.tile2x2 = function (imgs, w, h) {
    var out = new ImageData(w, h), d = out.data;
    var hw = w >> 1, hh = h >> 1;
    var i, k, x, y, o, q, src, ox, oy;
    for (k = 0; k < 4; k++) {
      src = imgs[k];
      ox = (k % 2) * hw; oy = (k >> 1) * hh;
      for (y = 0; y < hh; y++) {
        for (x = 0; x < hw; x++) {
          o = ((y + oy) * w + (x + ox)) * 4;
          q = (y * src.width + x) * 4;
          d[o] = src.data[q]; d[o + 1] = src.data[q + 1];
          d[o + 2] = src.data[q + 2]; d[o + 3] = 255;
        }
      }
    }
    /* 面の境目に細い線を引いて、4枚だと一目で分かるようにする */
    for (i = 0; i < w; i++) {
      o = (hh * w + i) * 4;
      d[o] = 40; d[o + 1] = 44; d[o + 2] = 52; d[o + 3] = 255;
    }
    for (y = 0; y < h; y++) {
      o = (y * w + hw) * 4;
      d[o] = 40; d[o + 1] = 44; d[o + 2] = 52; d[o + 3] = 255;
    }
    /* 奇数サイズで余った右端・下端を、隣の画素で埋めておく */
    if (w & 1) {
      for (y = 0; y < h; y++) {
        o = (y * w + w - 1) * 4; q = o - 4;
        d[o] = d[q]; d[o + 1] = d[q + 1]; d[o + 2] = d[q + 2]; d[o + 3] = 255;
      }
    }
    if (h & 1) {
      for (x = 0; x < w; x++) {
        o = ((h - 1) * w + x) * 4; q = o - w * 4;
        d[o] = d[q]; d[o + 1] = d[q + 1]; d[o + 2] = d[q + 2]; d[o + 3] = 255;
      }
    }
    return out;
  };

  /* ---------- Worker へ持ち出す部品 ---------- */

  /* file:// のページからは、Worker の中で importScripts('js/core.js') が使えない
   * （origin が null 扱いになり NetworkError。Chrome 152 で実測ずみ）。
   * そこで、ここに挙げた名前だけを関数の文字列に変換して Blob に同梱する。
   * js/worker.js の buildSource() がこの表を読む。
   *
   * 足すときの条件は「外側の変数を参照しないこと」。
   * U.〇〇 どうしの参照は、Worker 側にも同じ名前の U を組み立てるので使ってよい。
   * 下の並びはその依存関係で閉じている（mergePlanes→clamp8、convolveSeparable→mir など）。 */
  U.workerConsts = ['RW', 'GW', 'BW'];
  U.workerExports = [
    'clamp', 'clamp8', 'mir', 'cloneImageData',
    'splitPlanes', 'mergePlanes', 'toGrayPlane', 'grayToImageData', 'histogram256',
    'gaussianKernel1d', 'boxKernel1d',
    'convolveSeparable', 'convolve2d', 'gaussianBlurPlane',
    'hash32', 'hashUnit', 'hashGauss', 'hashPoisson', 'noiseBand',
    'psnr', 'psnrMasked', 'ssimRef', 'ssimAgainst', 'ssim', 'halveImage', 'tile2x2',
    'edgeIndex', 'cubicWeight', 'sampleImage', 'interpTaps', 'interpName'
  ];

  /* ---------- 別の処理を呼ぶための入口 ----------
   *
   * 「ノイズを乗せてから3手法を掛けて並べる」のように、1つの処理の中から
   * 別の処理の中身を呼びたいことがある。そのとき IL.opById[…] を直接触ると、
   * Worker の中では IL が存在しないので壊れる（kernel と prepare は文字列化されて
   * 別の実行文脈へ運ばれるため）。
   *
   * そこで U.opKernel / U.opPrepare という入口だけを決めておき、
   * 中身は環境ごとに差し替える。ここに書いてあるのはページ側（と Node）用で、
   * Worker 側の実装は js/worker.js の buildSource() が別に書き出す。
   * この2つは workerExports に載せない（載せるとページ側の実装が上書きされてしまう）。
   *
   * 呼ぶ側は必ず「prepare → kernel」の順で使うこと。
   *   var c = U.opPrepare('median')(img, mp);
   *   var out = U.opKernel('median')(img, mp, 0, img.height, c);
   */
  U.opKernel = function (id) {
    var op = IL.opById[id];
    if (!op || typeof op.kernel !== 'function') throw new Error('kernel が無い処理です: ' + id);
    return op.kernel;
  };
  U.opPrepare = function (id) {
    var op = IL.opById[id];
    if (!op) throw new Error('知らない処理です: ' + id);
    return op.prepare || function () { return null; };
  };

  /* ---------- 表示補助（続き） ---------- */

  /* 差分画像：|a-b| を増幅して表示 */
  U.diffImageData = function (a, b, gain) {
    var w = a.width, h = a.height, out = new ImageData(w, h);
    var da = a.data, db = b.data, d = out.data, n = w * h * 4;
    for (var j = 0; j < n; j += 4) {
      d[j] = U.clamp8(Math.abs(da[j] - db[j]) * gain);
      d[j + 1] = U.clamp8(Math.abs(da[j + 1] - db[j + 1]) * gain);
      d[j + 2] = U.clamp8(Math.abs(da[j + 2] - db[j + 2]) * gain);
      d[j + 3] = 255;
    }
    return out;
  };
})();
