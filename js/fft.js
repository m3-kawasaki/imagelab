/* ImageLab — fft.js
 * 2次元 FFT（Cooley-Tukey・radix-2・反復版）と、周波数領域の処理で使う道具立て。
 * 外部ライブラリは使わない（設計書 §2「同好会で中身を見せることが価値」）。
 *
 * ■ ここに置いた関数は Worker の中でも動く
 *
 * 末尾で U.workerExports に名前を足しているので、js/worker.js が
 * toString() で文字列化して Blob に同梱する。したがって、この中の関数には
 *   1. 外側の変数を参照しない（使ってよいのは U.〇〇 と引数だけ）
 *   2. 「function (…) {…}」の形で書く
 * という2つの制約が掛かる。IL.〇〇 は Worker 側に存在しないので使えない。
 * （ファイル末尾の IL.spectrumPreview だけは例外。ページ側専用）
 *
 * ■ 画像サイズと2の冪
 *
 * radix-2 の FFT は長さが2の冪でなければ回らない。そこで画像を
 * 各辺の「次の2の冪」まで広げてから変換し、逆変換のあとで元の大きさに切り戻す。
 * 640×480 なら 1024×512 の格子で計算することになる。
 * 広げた部分は既定で鏡映（reflect101）で埋める。ゼロで埋めると画像の縁に
 * 段差ができ、スペクトルに強い十字が出る（この十字は「境界処理」を
 * ゼロ詰めに切り替えると見える。教材としてはそちらも面白い）。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  /* ---------------- 1次元 FFT ---------------- */

  U.nextPow2 = function (n) { var p = 1; while (p < n) p <<= 1; return p; };

  /* 段取り表。ビット反転の並べ替え表と回転因子（twiddle factor）を先に作る。
     長さが同じなら使い回せるので、prepare で一度だけ作って持ち回る。 */
  U.fftPlan = function (n) {
    var levels = 0;
    while ((1 << levels) < n) levels++;

    var rev = new Uint32Array(n), i, j, b, x;
    for (i = 0; i < n; i++) {
      x = i; j = 0;
      for (b = 0; b < levels; b++) { j = (j << 1) | (x & 1); x >>= 1; }
      rev[i] = j;
    }

    var half = n >> 1;
    var wr = new Float64Array(half || 1), wi = new Float64Array(half || 1);
    for (i = 0; i < half; i++) {
      var a = -2 * Math.PI * i / n;
      wr[i] = Math.cos(a); wi[i] = Math.sin(a);
    }
    return { n: n, levels: levels, rev: rev, wr: wr, wi: wi };
  };

  /* その場（in-place）で回す反復版 Cooley-Tukey。
   *
   * 再帰で書くと「偶数番目と奇数番目に分ける」構造がそのまま見えるが、
   * 分割のたびに配列を作るので遅い。先にビット反転の順へ並べ替えておくと、
   * 隣り合った2点 → 4点 → 8点 … と下から積み上げるだけで同じ計算になる。
   *
   * off / stride を取るのは、2次元でそのまま行にも列にも使えるようにするため。
   * inverse は回転因子の符号を反転するだけ（1/N の割り算は fft2d 側でまとめて行う）。 */
  U.fft1d = function (re, im, off, stride, plan, inverse) {
    var n = plan.n, rev = plan.rev, wr = plan.wr, wi = plan.wi;
    var i, j, a, b, tr, ti;

    /* ビット反転の並べ替え */
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) {
        a = off + i * stride; b = off + j * stride;
        tr = re[a]; re[a] = re[b]; re[b] = tr;
        ti = im[a]; im[a] = im[b]; im[b] = ti;
      }
    }

    /* バタフライ演算。size が段の幅（2, 4, 8, … n） */
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var start = 0; start < n; start += size) {
        for (var k = 0, tw = 0; k < half; k++, tw += step) {
          var pi = off + (start + k) * stride, qi = pi + half * stride;
          var cr = wr[tw], ci = inverse ? -wi[tw] : wi[tw];
          var qr = re[qi], qm = im[qi];
          tr = qr * cr - qm * ci;
          ti = qr * ci + qm * cr;
          re[qi] = re[pi] - tr; im[qi] = im[pi] - ti;
          re[pi] = re[pi] + tr; im[pi] = im[pi] + ti;
        }
      }
    }
  };

  /* 2次元 FFT。2次元の DFT は「行ごとに1次元 → 列ごとに1次元」に分けられる
     （分離可能）。素朴に2次元で回すと O(N²) だが、これで O(N log N) になる。 */
  U.fft2d = function (re, im, W, H, planW, planH, inverse) {
    var x, y, i, n = W * H;

    for (y = 0; y < H; y++) U.fft1d(re, im, y * W, 1, planW, inverse);

    /* 列は W 個おきの飛び飛びなので、いったん連続した作業配列へ集めてから回す。
       stride 付きのまま回すと段ごとにキャッシュを外し、実測で2〜3倍遅い。 */
    var cr = new Float32Array(H), ci = new Float32Array(H);
    for (x = 0; x < W; x++) {
      for (y = 0; y < H; y++) { i = y * W + x; cr[y] = re[i]; ci[y] = im[i]; }
      U.fft1d(cr, ci, 0, 1, planH, inverse);
      for (y = 0; y < H; y++) { i = y * W + x; re[i] = cr[y]; im[i] = ci[y]; }
    }

    if (inverse) {
      var s = 1 / n;
      for (i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  };

  /* ---------------- 画像 ⇄ 周波数領域 ---------------- */

  /* 画像のプレーンを W×H（2の冪）の格子へ写す。
     mode: 'reflect'（鏡映で埋める・既定） / 'zero'（外は0） / 'hann'（窓を掛けて外は0） */
  U.fftPad = function (plane, w, h, W, H, mode) {
    var out = new Float32Array(W * H), x, y, v;

    if (mode === 'reflect') {
      for (y = 0; y < H; y++) {
        var sy = U.mir(y, h) * w, row = y * W;
        for (x = 0; x < W; x++) out[row + x] = plane[sy + U.mir(x, w)];
      }
      return out;
    }

    var wx = null, wy = null;
    if (mode === 'hann') {
      wx = new Float32Array(w); wy = new Float32Array(h);
      for (x = 0; x < w; x++) wx[x] = 0.5 - 0.5 * Math.cos(2 * Math.PI * x / (w > 1 ? w - 1 : 1));
      for (y = 0; y < h; y++) wy[y] = 0.5 - 0.5 * Math.cos(2 * Math.PI * y / (h > 1 ? h - 1 : 1));
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        v = plane[y * w + x];
        if (wx) v = v * wx[x] * wy[y];
        out[y * W + x] = v;
      }
    }
    return out;
  };

  /* 画像を周波数領域へ移す。mono なら輝度1枚、そうでなければ R/G/B の3枚。
     返り値の re / im がスペクトル（ビン番号でそのまま添字を引ける並び。
     DC は中央ではなく [0]。中央へ寄せるのは表示のときだけ）。 */
  U.fftAnalyze = function (src, mono, edge) {
    var w = src.width, h = src.height;
    var W = U.nextPow2(w), H = U.nextPow2(h);
    var planW = U.fftPlan(W), planH = U.fftPlan(H);
    var planes = mono ? [U.toGrayPlane(src)] : U.splitPlanes(src);
    var re = [], im = [], i;
    for (i = 0; i < planes.length; i++) {
      var r = U.fftPad(planes[i], w, h, W, H, edge);
      var m = new Float32Array(W * H);
      U.fft2d(r, m, W, H, planW, planH, false);
      re.push(r); im.push(m);
    }
    return { w: w, h: h, W: W, H: H, planW: planW, planH: planH,
             re: re, im: im, mono: !!mono };
  };

  /* ビンごとの通過率 gain（長さ W*H）を掛ける。これが「周波数フィルタ」の本体。
     空間領域の畳み込みが、周波数領域では掛け算1回で済む（畳み込み定理）。 */
  U.fftApplyGain = function (ctx, gain) {
    if (!gain) return;
    var n = ctx.W * ctx.H, c, i, g, r, m;
    for (c = 0; c < ctx.re.length; c++) {
      r = ctx.re[c]; m = ctx.im[c];
      for (i = 0; i < n; i++) { g = gain[i]; r[i] *= g; m[i] *= g; }
    }
  };

  /* 逆変換して画像に戻す。実数画像のスペクトルは共役対称なので、
     対称を保ったまま加工していれば虚部はほぼ 0 になる。実部だけを採る。 */
  U.fftToImage = function (ctx) {
    var W = ctx.W, w = ctx.w, h = ctx.h, c, x, y, i, o;
    for (c = 0; c < ctx.re.length; c++) {
      U.fft2d(ctx.re[c], ctx.im[c], W, ctx.H, ctx.planW, ctx.planH, true);
    }
    var r0 = ctx.re[0];
    var r1 = ctx.mono ? r0 : ctx.re[1];
    var r2 = ctx.mono ? r0 : ctx.re[2];
    var out = new ImageData(w, h), d = out.data;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * W + x; o = (y * w + x) * 4;
        d[o] = U.clamp8(r0[i]); d[o + 1] = U.clamp8(r1[i]); d[o + 2] = U.clamp8(r2[i]);
        d[o + 3] = 255;
      }
    }
    return out;
  };

  /* ---------------- 座標の対応づけ ---------------- */

  /* 「DC を中央に寄せた並び」での位置 s（0..n-1、DC は n/2）を、
     G 分割の格子番号へ丸める。
     DC を中心に左右対称に丸めるのが要点。単純な floor だと対称が半セルずれ、
     共役対称が崩れて逆変換の結果に虚部が残る。 */
  U.fftGridIndex = function (s, n, G) {
    var t = (s - (n >> 1)) * G / n;
    var q = (t >= 0) ? Math.floor(t + 0.5) : -Math.floor(0.5 - t);
    var g = (G >> 1) + q;
    return ((g % G) + G) % G;
  };

  /* 表示画像の x（幅 dw）→ 長さ n の実際のビン番号。
     表示は左端が −ナイキスト、中央が DC、右端が +ナイキスト手前。 */
  U.fftDisplayBin = function (x, dw, n) {
    var t = (x - (dw >> 1)) * n / dw;
    var s = (n >> 1) + ((t >= 0) ? Math.floor(t + 0.5) : -Math.floor(0.5 - t));
    var k = (s + (n >> 1)) % n;
    return ((k % n) + n) % n;
  };

  /* ---------------- 表示 ---------------- */

  U.hsvToRgb = function (hDeg, s, v) {
    var c = v * s, x = c * (1 - Math.abs(((hDeg / 60) % 2) - 1)), m = v - c;
    var r = 0, g = 0, b = 0;
    if (hDeg < 60) { r = c; g = x; }
    else if (hDeg < 120) { r = x; g = c; }
    else if (hDeg < 180) { g = c; b = x; }
    else if (hDeg < 240) { g = x; b = c; }
    else if (hDeg < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  };

  /* 対数パワースペクトルを画像にする。
   *
   * 生のパワーは DC が桁違いに大きく（自然画像で 10⁵ 倍以上）、
   * そのまま線形で描くと中央の1点だけが光って他は真っ黒になる。
   * そこで log で圧縮する。gain は圧縮の強さで、a = 10^gain。
   *
   * gainArr（長さ W*H・任意）を渡すと、遮っている場所に赤みを乗せる。
   * dw / dh を渡すとその大きさで描く（右パネルの小さいスペクトル用）。 */
  U.fftSpectrumImage = function (ctx, gain, gainArr, dw, dh) {
    var W = ctx.W, H = ctx.H, n = W * H;
    var w = dw || ctx.w, h = dh || ctx.h;
    var i, c, x, y, r, m;

    var pw = new Float32Array(n), mx = 0;
    for (c = 0; c < ctx.re.length; c++) {
      r = ctx.re[c]; m = ctx.im[c];
      for (i = 0; i < n; i++) pw[i] += r[i] * r[i] + m[i] * m[i];
    }
    for (i = 0; i < n; i++) {
      pw[i] = Math.sqrt(pw[i]);
      if (pw[i] > mx) mx = pw[i];
    }
    if (!(mx > 0)) mx = 1;

    var a = Math.pow(10, gain), la = Math.log(1 + a);
    var kxs = new Int32Array(w);
    for (x = 0; x < w; x++) kxs[x] = U.fftDisplayBin(x, w, W);

    var out = new ImageData(w, h), d = out.data;
    for (y = 0; y < h; y++) {
      var ky = U.fftDisplayBin(y, h, H) * W;
      for (x = 0; x < w; x++) {
        i = ky + kxs[x];
        var v = 255 * Math.log(1 + a * (pw[i] / mx)) / la;
        var rr = v, gg = v, bb = v;
        if (gainArr) {
          var t = 1 - gainArr[i];
          if (t > 0.001) {              /* 遮った場所は赤みを乗せて、形が見えるようにする */
            rr = v + (150 - v * 0.4) * t;
            gg = v * (1 - 0.55 * t);
            bb = v * (1 - 0.55 * t);
          }
        }
        var o = (y * w + x) * 4;
        d[o] = U.clamp8(rr); d[o + 1] = U.clamp8(gg); d[o + 2] = U.clamp8(bb); d[o + 3] = 255;
      }
    }
    return out;
  };

  /* 位相を色相で、強さを明るさで見せる。位相は値そのものには意味が読み取りにくいが、
     「どこに情報が入っているか」を示すのには使える。 */
  U.fftPhaseImage = function (ctx, gain, dw, dh) {
    var W = ctx.W, H = ctx.H, n = W * H;
    var w = dw || ctx.w, h = dh || ctx.h;
    var re = ctx.re[0], im = ctx.im[0], i, x, y;

    var mag = new Float32Array(n), mx = 0;
    for (i = 0; i < n; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      if (mag[i] > mx) mx = mag[i];
    }
    if (!(mx > 0)) mx = 1;

    var a = Math.pow(10, gain), la = Math.log(1 + a);
    var kxs = new Int32Array(w);
    for (x = 0; x < w; x++) kxs[x] = U.fftDisplayBin(x, w, W);

    var out = new ImageData(w, h), d = out.data;
    for (y = 0; y < h; y++) {
      var ky = U.fftDisplayBin(y, h, H) * W;
      for (x = 0; x < w; x++) {
        i = ky + kxs[x];
        var ang = Math.atan2(im[i], re[i]) * 180 / Math.PI;
        if (ang < 0) ang += 360;
        var v = Math.log(1 + a * (mag[i] / mx)) / la;
        var col = U.hsvToRgb(ang, 1, v);
        var o = (y * w + x) * 4;
        d[o] = U.clamp8(col[0]); d[o + 1] = U.clamp8(col[1]); d[o + 2] = U.clamp8(col[2]);
        d[o + 3] = 255;
      }
    }
    return out;
  };

  /* W×H のプレーンから w×h を切り出し、min/max で 0..255 に伸ばして表示する。
     shift を立てると原点（0,0）が中央に来るように巻き直してから切る
     （振幅だけの再構成のように、結果が原点に集まる場合に使う）。 */
  U.fftPlaneToImage = function (plane, W, H, w, h, shift) {
    var x, y, i, v, lo = Infinity, hi = -Infinity;
    var tmp = new Float32Array(w * h);
    for (y = 0; y < h; y++) {
      var sy = shift ? (((y - (h >> 1)) % H) + H) % H : y;
      for (x = 0; x < w; x++) {
        var sx = shift ? (((x - (w >> 1)) % W) + W) % W : x;
        v = plane[sy * W + sx];
        tmp[y * w + x] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    var span = (hi - lo) || 1;
    var out = new ImageData(w, h), d = out.data;
    for (i = 0; i < w * h; i++) {
      var g = (tmp[i] - lo) * 255 / span, o = i * 4;
      d[o] = U.clamp8(g); d[o + 1] = U.clamp8(g); d[o + 2] = U.clamp8(g); d[o + 3] = 255;
    }
    return out;
  };

  /* prepare で作りきった画像から、行帯 [y0, y1) だけを切り出して返す。
     FFT は画像全体を一度に扱うので帯には分けられない。そこで周波数領域の処理は
     「prepare で最後まで作り、kernel はそこから切って渡すだけ」という形にしている
     （帯に分けられないことは halo を画像の高さ以上にして worker.js へ伝える）。 */
  U.rowsOf = function (img, y0, y1) {
    var w = img.width, out = new ImageData(w, y1 - y0);
    out.data.set(img.data.subarray(y0 * w * 4, y1 * w * 4));
    return out;
  };

  /* スペクトルの上に目盛りを重ねる。中心を通る十字と、
     正規化周波数 0.125 / 0.25 / 0.375（サイクル/画素）の円。
     「この輝点はどのくらいの細かさか」を目で読むための補助線。 */
  U.fftAxesOverlay = function (img) {
    var w = img.width, h = img.height, d = img.data;
    var cx = w >> 1, cy = h >> 1, x, y, i, k;
    var rings = [0.125, 0.25, 0.375];
    for (y = 0; y < h; y++) {
      var v = (y - cy) / h;
      for (x = 0; x < w; x++) {
        var u = (x - cx) / w;
        var hit = (x === cx || y === cy);
        if (!hit) {
          var r = Math.sqrt(u * u + v * v);
          for (k = 0; k < 3; k++) if (Math.abs(r - rings[k]) < 0.0018) { hit = true; break; }
        }
        if (!hit) continue;
        i = (y * w + x) * 4;
        d[i] = U.clamp8(d[i] * 0.35 + 100);
        d[i + 1] = U.clamp8(d[i + 1] * 0.35 + 180);
        d[i + 2] = U.clamp8(d[i + 2] * 0.35 + 215);
      }
    }
    return img;
  };

  /* ---------------- Worker へ持ち出す ---------------- */

  /* js/core.js の U.workerExports に足しておくと、js/worker.js が
     文字列化して Blob に同梱してくれる（詳しくは worker.js の頭のコメント）。 */
  ['nextPow2', 'fftPlan', 'fft1d', 'fft2d', 'fftPad', 'fftAnalyze', 'fftApplyGain',
   'fftToImage', 'fftGridIndex', 'fftDisplayBin', 'hsvToRgb', 'fftSpectrumImage',
   'fftPhaseImage', 'fftPlaneToImage', 'rowsOf', 'fftAxesOverlay'
  ].forEach(function (k) { U.workerExports.push(k); });

  /* 周波数領域の処理の重さの見積り（ミリ秒）。Worker に回すかの判断に使う。
     係数は node docs/_bench.js の実測から起こした。
     変換1回あたり W·H·(log₂W + log₂H) に、スペクトルを描く1回あたり W·H に比例する
     （描くほうは全ビンのパワーを取って log を掛けるので、変換ほどではないが効く）。 */
  U.fftCost = function (w, h, channels, transforms, displays) {
    var W = U.nextPow2(w), H = U.nextPow2(h);
    return W * H * ((Math.log2(W) + Math.log2(H)) * channels * transforms * 6.0e-6 +
                    (displays || 0) * 7.0e-5);
  };
  U.workerExports.push('fftCost');

  /* ---------------- ここから下はページ側専用 ---------------- */

  /* 右パネルのマスク編集用に、原画のスペクトルを小さく描く。
     1回あたり 640×480 で数十ミリ秒かかるので、同じ画像なら作り直さない。
     （Worker には出さない。閉じ込めた cache を参照しているので文字列化できない）

     これはメインスレッドで走る。作業解像度を上げたり原寸の写真を読み込んだりすると
     格子が 2048×2048 以上になり、下敷きを描くだけで数秒画面が止まってしまう。
     縮めてから変換する手は使えない。周波数の目盛りがずれて、塗った場所と
     実際に遮る場所が食い違うため。そこで大きいときは下敷きを諦めて null を返す
     （中央のビューアに「マスクを掛けたあとのスペクトル」を出せば確認はできる）。 */
  var PREVIEW_LIMIT = 1024 * 1024;

  /* 変換そのものの結果を持ち回る。下敷きの描画と輝点さがしの両方で使うので、
     同じ画像なら1回で済ませる。どちらも読むだけなので共有してよい
     （加工する処理は自分で fftAnalyze を呼ぶ。ここのものには触らない）。 */
  var actx = null;
  function analyzed(src, edge) {
    if (actx && actx.src === src && actx.edge === edge) return actx.ctx;
    actx = { src: src, edge: edge, ctx: U.fftAnalyze(src, true, edge) };
    return actx.ctx;
  }

  var cache = null;
  IL.spectrumPreview = function (src, dw, dh, gain, edge) {
    if (U.nextPow2(src.width) * U.nextPow2(src.height) > PREVIEW_LIMIT) return null;
    if (cache && cache.src === src && cache.dw === dw && cache.dh === dh &&
        cache.gain === gain && cache.edge === edge) return cache.img;
    var img = U.fftSpectrumImage(analyzed(src, edge), gain, null, dw, dh);
    cache = { src: src, dw: dw, dh: dh, gain: gain, edge: edge, img: img };
    return img;
  };

  /* 「ここを塗ればいい」輝点をさがす。
   *
   * 周期ノイズ（斜め縞）のような規則正しい模様は、スペクトルに孤立した輝点として立つ。
   * ところが人の目には、その1点が周りの模様に紛れて見つけにくい。
   * そこで機械のほうで見つけて、印をつけられるようにする。
   *
   * 自然画像のパワーは中心から離れるほど落ちていくので、絶対値の大小で選ぶと
   * 中心近くばかりが引っかかる。そこで「同じ半径の平均に対して何倍か」で測る。
   * これなら、周りから突出しているものだけが残る。
   *
   * 除くもの：
   *   ・DC の近く（r < 0.02）… いつも一番明るいが、模様ではなく全体の明るさ
   *   ・十字（fx か fy が 0 付近）… 2の冪へ広げた縁の食い違いが作る成分で、
   *     画像そのものには無い模様（ops/fft.js の解説を参照）
   *   ・ナイキストのすぐ手前（r > 0.45）… 斜めの縁のギザギザが作る成分で、
   *     ここも絵の模様ではない
   *   ・輝「線」の上の点 … エッジの多い絵はスペクトルに線が伸びる。線の上の点は
   *     「同じ半径の平均」より高いので、それだけでは弾けない。すぐ周りの環と
   *     比べて、ぽつんと立っているものだけを残す
   *
   * 返すのは正規化周波数 u, v（−0.5〜0.5）の並び。点対称の相方も別々に入る
   * （両方に印が出たほうが、片方を塗ると反対側にも乗る仕組みが伝わる）。
   * 突出したものが無ければ空の配列。自然写真では普通そうなる。 */
  var peakCache = null;
  IL.spectrumPeaks = function (src, edge) {
    if (peakCache && peakCache.src === src && peakCache.edge === edge) return peakCache.peaks;
    var peaks = [];
    if (U.nextPow2(src.width) * U.nextPow2(src.height) <= PREVIEW_LIMIT) {
      peaks = findPeaks(analyzed(src, edge));
    }
    peakCache = { src: src, edge: edge, peaks: peaks };
    return peaks;
  };

  var PEAK_RATIO = 40;      /* 同じ半径の平均の何倍で「突出している」とみなすか */
  var PEAK_LOCAL = 25;      /* すぐ周り（半径4〜8ビンの環）の平均の何倍か */
  var PEAK_REL = 8;         /* いちばん強い輝点の何分の1までを拾うか */
  var PEAK_MAX = 6;         /* 印をつける数の上限。多すぎると画面が埋まる */
  var PEAK_RMAX = 0.45;     /* ナイキストのすぐ手前は見ない（下の理由） */

  function findPeaks(ctx) {
    var W = ctx.W, H = ctx.H, re = ctx.re[0], im = ctx.im[0];
    var kx, ky, i, fx, fy, u, v, r;

    /* 半径ごとの平均パワー。半径は 0〜0.71（角の √2/2）を 64 段に分ける */
    var NB = 64, sum = new Float64Array(NB), cnt = new Float64Array(NB);
    var pw = new Float64Array(W * H);
    for (ky = 0; ky < H; ky++) {
      fy = (ky < H / 2) ? ky : ky - H;
      v = fy / H;
      for (kx = 0; kx < W; kx++) {
        fx = (kx < W / 2) ? kx : kx - W;
        u = fx / W;
        i = ky * W + kx;
        pw[i] = re[i] * re[i] + im[i] * im[i];
        r = Math.sqrt(u * u + v * v);
        var b = Math.min(NB - 1, Math.floor(r / 0.7072 * NB));
        sum[b] += pw[i]; cnt[b]++;
      }
    }
    for (i = 0; i < NB; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;

    /* 周りより高く、かつ同じ半径の平均より飛び抜けているビンを拾う */
    var found = [];
    for (ky = 0; ky < H; ky++) {
      fy = (ky < H / 2) ? ky : ky - H;
      if (Math.abs(fy) <= 1) continue;                 /* 横に走る十字 */
      v = fy / H;
      for (kx = 0; kx < W; kx++) {
        fx = (kx < W / 2) ? kx : kx - W;
        if (Math.abs(fx) <= 1) continue;               /* 縦に走る十字 */
        u = fx / W;
        r = Math.sqrt(u * u + v * v);
        if (r < 0.02 || r > PEAK_RMAX) continue;

        i = ky * W + kx;
        var base = sum[Math.min(NB - 1, Math.floor(r / 0.7072 * NB))];
        if (base <= 0) continue;
        var score = pw[i] / base;
        if (score < PEAK_RATIO) continue;

        /* 8近傍より高いこと（周波数の面は端でつながっているので巻き戻す） */
        var top = true, dx, dy;
        for (dy = -1; dy <= 1 && top; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = ((kx + dx) % W + W) % W, ny = ((ky + dy) % H + H) % H;
            if (pw[ny * W + nx] > pw[i]) { top = false; break; }
          }
        }
        if (!top) continue;

        /* すぐ周りと比べて、ぽつんと立っているか。
           ここが要。エッジの多い絵は、スペクトルに輝「線」が伸びる。
           線の上の1点は同じ半径の平均よりずっと高いので、上の条件だけだと通ってしまう。
           だが線の上では、すぐ隣（線に沿った先）も同じくらい高い。
           少し離れた環と比べれば、線は落ち、孤立した点だけが残る。 */
        var rs = 0, rn = 0;
        for (dy = -8; dy <= 8; dy++) {
          for (dx = -8; dx <= 8; dx++) {
            var dd = dx * dx + dy * dy;
            if (dd < 16 || dd > 64) continue;      /* 半径 4〜8 ビンの環 */
            rs += pw[(((ky + dy) % H + H) % H) * W + (((kx + dx) % W + W) % W)];
            rn++;
          }
        }
        var local = rn ? rs / rn : 0;
        if (local <= 0 || pw[i] / local < PEAK_LOCAL) continue;

        found.push({ u: u, v: v, score: Math.min(score, pw[i] / local) });
      }
    }

    /* 強い順に、近すぎるものをまとめながら拾う。
       いちばん強いものと桁が違うものは落とす。周期ノイズは飛び抜けて強く出るので、
       それに比べて弱いものは、たいてい縞の倍音か絵そのものの模様で、
       塗っても縞は消えない（案内としてはかえって邪魔になる）。 */
    found.sort(function (a, b) { return b.score - a.score; });
    var floor = found.length ? found[0].score / PEAK_REL : 0;
    var out = [];
    for (i = 0; i < found.length && out.length < PEAK_MAX; i++) {
      if (found[i].score < floor) break;
      var ok = true;
      for (var j = 0; j < out.length; j++) {
        var du = found[i].u - out[j].u, dv = found[i].v - out[j].v;
        if (du * du + dv * dv < 0.02 * 0.02) { ok = false; break; }
      }
      if (ok) out.push(found[i]);
    }
    return out;
  }

  /* 手描きマスクの格子の細かさ。画像の大きさに依存させないために、
     正規化周波数 −0.5〜0.5 を GRID 等分した固定の格子で持つ。
     作業解像度を変えてもマスクはそのまま使える。 */
  IL.MASK_GRID = 128;
})();
