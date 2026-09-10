/* ImageLab — ops/demosaic.js : デモザイク（Bayer 配列 → バイリニア vs AHD）
 *
 * ■ 何をしているか
 *   カラーの原画を、いったん「1画素1色」の Bayer 配列に間引く（＝センサが実際に
 *   受け取る値を作る）。そこから2つのやり方でカラーに戻し、原画と比べる。
 *   ノイズ除去の比較（denoisecmp.js）とまったく同じ形で、正解を自分で用意している。
 *
 * ■ 2つのやり方
 *   バイリニア … 足りない色を、周りの同じ色の画素の平均で埋めるだけ。
 *                 細かい模様のところで「ジッパーノイズ」と「偽色」が出る。
 *   AHD        … Adaptive Homogeneity-Directed（Hirakawa & Parks, 2005）。
 *                 横向きと縦向きの2通りに補間しておいて、画素ごとに
 *                 「周りと馴染んでいるほう」を採る。手順は4段：
 *                   1. 方向別の G（Hamilton-Adams。色差の2階差分で補正する）
 *                   2. 方向ごとに R−G / B−G を補間して R, B を戻す
 *                   3. 両方を CIELab に直し、4近傍との差から「一様性」を数える
 *                   4. 3×3 で一様性を足し、多いほうの向きを採る
 *                 最後に色差（R−G, B−G）の 3×3 メディアンで残った偽色を落とす。
 *
 * ■ この処理は行帯に分けられない
 *   PSNR / SSIM が画像全体の集計なので帯ごとに出せない。
 *   halo に大きい値を返して、丸ごと1つのワーカーへ渡している。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'demosaic',
    category: 'sensor',
    label: 'デモザイク（バイリニア vs AHD）',

    params: [
      { key: 'view', type: 'select', label: '表示', value: 'tile',
        options: [{ value: 'tile', label: '4分割で並べる（実演向け）' },
                  { value: 'orig', label: '原画（全解像度）' },
                  { value: 'bayer', label: 'Bayer 生データ（全解像度）' },
                  { value: 'bilinear', label: 'バイリニア（全解像度）' },
                  { value: 'ahd', label: 'AHD（全解像度）' }] },

      { key: 'pattern', type: 'select', label: 'CFA の並び', value: 'RGGB',
        options: [{ value: 'RGGB', label: 'RGGB（左上が R）' },
                  { value: 'BGGR', label: 'BGGR（左上が B）' },
                  { value: 'GRBG', label: 'GRBG（左上が G・右が R）' },
                  { value: 'GBRG', label: 'GBRG（左上が G・右が B）' }] },

      { key: 'bayerview', type: 'select', label: 'Bayer の見せ方', value: 'color',
        options: [{ value: 'color', label: 'モザイク（受け取った色に置く）' },
                  { value: 'gray', label: '素の値（グレー）' }],
        when: function (p) { return p.view === 'tile' || p.view === 'bayer'; } },

      { key: 'med', type: 'range', label: 'AHD の後処理（色差メディアン）',
        min: 0, max: 3, step: 1, value: 1,
        format: function (v) { return v === 0 ? 'なし' : v + ' 回'; } }
    ],

    /* 全体を1つのワーカーへ（帯には分けられない。頭のコメントを参照） */
    halo: function () { return 1e9; },

    cost: function (w, h, p) {
      /* 係数は node docs/_bench.js の実測から。
         バイリニアは 3×3 の畳み込み3枚ぶん、AHD は方向2通りぶんの補間と
         Lab 変換と一様性の集計。メディアンは1回ごとに上乗せ。 */
      var bilinear = w * h * 2.6e-5;
      var ahd = w * h * 5.5e-4;
      var med = w * h * p.med * 3.5e-4;
      var metrics = w * h * 2 * 2.3e-4;      /* PSNR / SSIM を2組 */
      return bilinear + ahd + med + metrics + w * h * 2.0e-5;
    },

    prepare: function (src, p) {
      var w = src.width, h = src.height, n = w * h;
      var i, x, y, k;

      /* ================= 0. CFA の並び ================= */

      /* pattern は左上 2×2 を「(0,0) (1,0) (0,1) (1,1)」の順に並べた文字列 */
      var ci = { R: 0, G: 1, B: 2 };
      var cfa = [ci[p.pattern.charAt(0)], ci[p.pattern.charAt(1)],
                 ci[p.pattern.charAt(2)], ci[p.pattern.charAt(3)]];
      function colorAt(x, y) { return cfa[(y & 1) * 2 + (x & 1)]; }

      /* 端は reflect101 の鏡映で読む。この鏡映は添字の偶奇を保つので
         （-1 → 1、-2 → 2、w → w-2）、鏡映しても CFA の色がずれない。
         ずれる境界処理（複製など）を使うと、端1〜2画素に色が湧く。 */
      function mx(v) { return U.mir(v, w); }
      function my(v) { return U.mir(v, h); }

      /* ================= 1. センサが受け取る値 ================= */

      var planes = U.splitPlanes(src);            /* [R, G, B] */
      var raw = new Float32Array(n);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) { i = y * w + x; raw[i] = planes[colorAt(x, y)][i]; }
      }

      /* その色の標本だけを残した面（残りは 0）。バイリニアはこれを畳み込むだけで出る */
      function sparse(c) {
        var a = new Float32Array(n), xx, yy, ii;
        for (yy = 0; yy < h; yy++) {
          for (xx = 0; xx < w; xx++) {
            ii = yy * w + xx;
            if (colorAt(xx, yy) === c) a[ii] = raw[ii];
          }
        }
        return a;
      }

      /* ================= 2. バイリニア =================
         G は上下左右の4点、R と B は「同じ行の左右／同じ列の上下／斜め4点」を
         まとめて 1-2-1 の重みで平均する。標本以外を 0 で埋めた面に対して
         この重みで畳み込むと、場所ごとの場合分けを書かずに同じ結果になる。 */
      var KG = new Float32Array([0, 0.25, 0, 0.25, 1, 0.25, 0, 0.25, 0]);
      var KRB = new Float32Array([0.25, 0.5, 0.25, 0.5, 1, 0.5, 0.25, 0.5, 0.25]);

      function conv3(a, kk) { return U.convolve2d(a, w, h, kk, 3, 3); }

      var bilR = conv3(sparse(0), KRB);
      var bilG = conv3(sparse(1), KG);
      var bilB = conv3(sparse(2), KRB);
      var bil = U.mergePlanes(bilR, bilG, bilB, w, h);

      /* ================= 3. AHD ================= */

      /* --- 3-1. 方向別の G（Hamilton-Adams） ---
         隣の G の平均に、中心の色の2階差分の 1/4 を足す。
         「G が滑らかなのではなく、G と R（B）の差が滑らかだ」という前提を
         そのまま式にしたもの。これがあるだけで細線の再現がかなり変わる。 */
      function greenDir(vertical) {
        var g = new Float32Array(n), xx, yy, ii, a, b, c2, d2, s;
        for (yy = 0; yy < h; yy++) {
          for (xx = 0; xx < w; xx++) {
            ii = yy * w + xx;
            if (colorAt(xx, yy) === 1) { g[ii] = raw[ii]; continue; }
            if (!vertical) {
              a = raw[yy * w + mx(xx - 1)]; b = raw[yy * w + mx(xx + 1)];
              c2 = raw[yy * w + mx(xx - 2)]; d2 = raw[yy * w + mx(xx + 2)];
            } else {
              a = raw[my(yy - 1) * w + xx]; b = raw[my(yy + 1) * w + xx];
              c2 = raw[my(yy - 2) * w + xx]; d2 = raw[my(yy + 2) * w + xx];
            }
            s = (a + b) * 0.5 + (2 * raw[ii] - c2 - d2) * 0.25;
            g[ii] = s < 0 ? 0 : (s > 255 ? 255 : s);
          }
        }
        return g;
      }

      /* --- 3-2. その G を使って R と B を戻す ---
         R そのものではなく R−G を補間する。色差のほうが平坦なので、
         同じバイリニアでも段違いに素直に埋まる。 */
      function rbFromGreen(g) {
        var dr = new Float32Array(n), db = new Float32Array(n), xx, yy, ii, c;
        for (yy = 0; yy < h; yy++) {
          for (xx = 0; xx < w; xx++) {
            ii = yy * w + xx; c = colorAt(xx, yy);
            if (c === 0) dr[ii] = raw[ii] - g[ii];
            else if (c === 2) db[ii] = raw[ii] - g[ii];
          }
        }
        var DR = conv3(dr, KRB), DB = conv3(db, KRB);
        var R = new Float32Array(n), B = new Float32Array(n), j;
        for (j = 0; j < n; j++) { R[j] = g[j] + DR[j]; B[j] = g[j] + DB[j]; }
        return { r: R, g: g, b: B };
      }

      var candH = rbFromGreen(greenDir(false));
      var candV = rbFromGreen(greenDir(true));

      /* --- 3-3. CIELab に直す ---
         一様性を「明るさ」と「色」で別々に測りたいので、
         人の感じ方に近い間隔をもつ座標に移す。sRGB → 線形 → XYZ(D65) → Lab。
         線形化は 0〜255 の表引きで済ませている（256 通りしか要らない）。 */
      var LIN = new Float32Array(256), t;
      for (i = 0; i < 256; i++) {
        t = i / 255;
        LIN[i] = t <= 0.04045 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4);
      }
      function lin(v) { return LIN[v < 0 ? 0 : (v > 255 ? 255 : (v + 0.5) | 0)]; }
      function fLab(v) { return v > 0.008856 ? Math.cbrt(v) : (7.787 * v + 0.137931); }

      function toLab(c) {
        var L = new Float32Array(n), A = new Float32Array(n), Bb = new Float32Array(n);
        var j, r, g2, b2, X, Y, Z, fx, fy, fz;
        for (j = 0; j < n; j++) {
          r = lin(c.r[j]); g2 = lin(c.g[j]); b2 = lin(c.b[j]);
          X = (0.4124 * r + 0.3576 * g2 + 0.1805 * b2) / 0.950456;
          Y = 0.2126 * r + 0.7152 * g2 + 0.0722 * b2;
          Z = (0.0193 * r + 0.1192 * g2 + 0.9505 * b2) / 1.088754;
          fx = fLab(X); fy = fLab(Y); fz = fLab(Z);
          L[j] = 116 * fy - 16; A[j] = 500 * (fx - fy); Bb[j] = 200 * (fy - fz);
        }
        return { L: L, A: A, B: Bb };
      }

      var labH = toLab(candH), labV = toLab(candV);

      /* --- 3-4. 一様性を数える ---
         上下左右の4近傍それぞれについて、明るさの差と色の差を測る。
         「横向きの左右の差」と「縦向きの上下の差」のうち小さいほうを許容範囲に取り、
         その範囲に収まった近傍の数を数える。正しい向きに補間できていれば
         模様が繋がるので周りと馴染み、間違えていれば市松に暴れて馴染まない。 */
      var dOff = [-1, 1, -w, w];                 /* 左・右・上・下 */
      var homoH = new Uint8Array(n), homoV = new Uint8Array(n);
      var ldH = new Float32Array(4), ldV = new Float32Array(4);
      var adH = new Float32Array(4), adV = new Float32Array(4);
      var j2, da, db2, leps, aeps, cH, cV;

      for (y = 1; y < h - 1; y++) {
        for (x = 1; x < w - 1; x++) {
          i = y * w + x;
          for (k = 0; k < 4; k++) {
            j2 = i + dOff[k];
            ldH[k] = Math.abs(labH.L[i] - labH.L[j2]);
            da = labH.A[i] - labH.A[j2]; db2 = labH.B[i] - labH.B[j2];
            adH[k] = da * da + db2 * db2;
            ldV[k] = Math.abs(labV.L[i] - labV.L[j2]);
            da = labV.A[i] - labV.A[j2]; db2 = labV.B[i] - labV.B[j2];
            adV[k] = da * da + db2 * db2;
          }
          leps = Math.min(ldH[0] > ldH[1] ? ldH[0] : ldH[1],
                          ldV[2] > ldV[3] ? ldV[2] : ldV[3]);
          aeps = Math.min(adH[0] > adH[1] ? adH[0] : adH[1],
                          adV[2] > adV[3] ? adV[2] : adV[3]);
          cH = 0; cV = 0;
          for (k = 0; k < 4; k++) {
            if (ldH[k] <= leps && adH[k] <= aeps) cH++;
            if (ldV[k] <= leps && adV[k] <= aeps) cV++;
          }
          homoH[i] = cH; homoV[i] = cV;
        }
      }

      /* --- 3-5. 3×3 で足して、多いほうの向きを採る ---
         1画素だけで決めると判定が市松に飛ぶので、少し広く見て多数決にする。
         同数のときは両方の平均（どちらとも言えない場所で片方に倒すと筋が出る）。 */
      var aR = new Float32Array(n), aG = new Float32Array(n), aB = new Float32Array(n);
      var sH, sV, dy, dx, base;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) {
            aR[i] = (candH.r[i] + candV.r[i]) * 0.5;
            aG[i] = (candH.g[i] + candV.g[i]) * 0.5;
            aB[i] = (candH.b[i] + candV.b[i]) * 0.5;
            continue;
          }
          sH = 0; sV = 0;
          for (dy = -1; dy <= 1; dy++) {
            base = i + dy * w;
            for (dx = -1; dx <= 1; dx++) { sH += homoH[base + dx]; sV += homoV[base + dx]; }
          }
          if (sH > sV) { aR[i] = candH.r[i]; aG[i] = candH.g[i]; aB[i] = candH.b[i]; }
          else if (sV > sH) { aR[i] = candV.r[i]; aG[i] = candV.g[i]; aB[i] = candV.b[i]; }
          else {
            aR[i] = (candH.r[i] + candV.r[i]) * 0.5;
            aG[i] = (candH.g[i] + candV.g[i]) * 0.5;
            aB[i] = (candH.b[i] + candV.b[i]) * 0.5;
          }
        }
      }

      /* --- 3-6. 色差のメディアン ---
         残った偽色は「R−G と B−G が1画素だけ飛び出している」形で出るので、
         色差のほうに 3×3 のメディアンをかけると落ちる。輝度は触らないので
         解像感は下がらない。AHD の論文にも後処理として書かれている段。 */
      function medianCD(R, G, B) {
        var d1 = new Float32Array(n), d2 = new Float32Array(n), j;
        for (j = 0; j < n; j++) { d1[j] = R[j] - G[j]; d2[j] = B[j] - G[j]; }
        var m1 = med3x3(d1), m2 = med3x3(d2);
        for (j = 0; j < n; j++) { R[j] = G[j] + m1[j]; B[j] = G[j] + m2[j]; }
      }

      function med3x3(a) {
        var out = new Float32Array(n), buf = new Float32Array(9);
        var xx, yy, ii, dy2, dx2, c, q, v, m;
        for (yy = 0; yy < h; yy++) {
          for (xx = 0; xx < w; xx++) {
            ii = yy * w + xx;
            c = 0;
            for (dy2 = -1; dy2 <= 1; dy2++) {
              for (dx2 = -1; dx2 <= 1; dx2++) {
                buf[c++] = a[my(yy + dy2) * w + mx(xx + dx2)];
              }
            }
            /* 9個なので挿入ソートで十分（部分選択より短く書けて速い） */
            for (q = 1; q < 9; q++) {
              v = buf[q]; m = q - 1;
              while (m >= 0 && buf[m] > v) { buf[m + 1] = buf[m]; m--; }
              buf[m + 1] = v;
            }
            out[ii] = buf[4];
          }
        }
        return out;
      }

      for (k = 0; k < p.med; k++) medianCD(aR, aG, aB);

      var ahd = U.mergePlanes(aR, aG, aB, w, h);

      /* ================= 4. Bayer 生データの絵 ================= */

      var bayer = new ImageData(w, h), bd = bayer.data, c3, v3;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x; v3 = U.clamp8(raw[i]);
          bd[i * 4 + 3] = 255;
          if (p.bayerview === 'gray') { bd[i * 4] = v3; bd[i * 4 + 1] = v3; bd[i * 4 + 2] = v3; }
          else { c3 = colorAt(x, y); bd[i * 4 + c3] = v3; }
        }
      }

      /* ================= 5. 原画と比べる ================= */

      var ref = U.ssimRef(src);
      var names = ['原画', 'Bayer 生データ', 'バイリニア', 'AHD'];
      var imgs = [src, bayer, bil, ahd];
      var nums = [null, null, null, null];

      function chromaMAE(a, b) {
        var da = a.data, db = b.data, s = 0, j, o, cb1, cr1, cb2, cr2;
        for (j = 0, o = 0; j < n; j++, o += 4) {
          cb1 = -0.168736 * da[o] - 0.331264 * da[o + 1] + 0.5 * da[o + 2];
          cr1 = 0.5 * da[o] - 0.418688 * da[o + 1] - 0.081312 * da[o + 2];
          cb2 = -0.168736 * db[o] - 0.331264 * db[o + 1] + 0.5 * db[o + 2];
          cr2 = 0.5 * db[o] - 0.418688 * db[o + 1] - 0.081312 * db[o + 2];
          s += Math.abs(cb1 - cb2) + Math.abs(cr1 - cr2);
        }
        return s / (2 * n);
      }

      for (i = 2; i < 4; i++) {
        var ps = U.psnr(src, imgs[i]);
        nums[i] = { psnr: ps, ptxt: isFinite(ps) ? ps.toFixed(1) : '∞',
                    ssim: U.ssimAgainst(ref, imgs[i]),
                    cma: chromaMAE(src, imgs[i]) };
      }

      /* ★は列ごとに1つ。バイリニアと AHD の2つで competing */
      var bp = 2, bs = 2, bc = 2;
      if (nums[3].psnr > nums[2].psnr) bp = 3;
      if (nums[3].ssim > nums[2].ssim) bs = 3;
      if (nums[3].cma < nums[2].cma) bc = 3;

      var rows = [['PSNR / SSIM', '★ が各列の最良']];
      for (i = 2; i < 4; i++) {
        rows.push([names[i],
                   (i === bp ? '★' : '') + nums[i].ptxt + ' dB / ' +
                   (i === bs ? '★' : '') + nums[i].ssim.toFixed(3)]);
      }
      rows.push(['偽色（色差の誤差）',
                 (bc === 2 ? '★' : '') + nums[2].cma.toFixed(2) + ' ／ ' +
                 (bc === 3 ? '★' : '') + nums[3].cma.toFixed(2) + '（バイリニア／AHD）']);
      rows.push(['CFA の並び', p.pattern + '（G が半分、R と B が 1/4 ずつ）']);

      /* ================= 6. 見せ方に合わせて1枚にする ================= */

      var out, tiles = null;
      if (p.view === 'tile') {
        out = U.tile2x2([U.halveImage(src), U.halveImage(bayer),
                         U.halveImage(bil), U.halveImage(ahd)], w, h);
        var hw = w >> 1, hh = h >> 1;
        tiles = [];
        for (i = 0; i < 4; i++) {
          tiles.push({ x: (i % 2) * hw, y: (i >> 1) * hh, w: hw, h: hh,
                       label: names[i],
                       sub: (i < 2)
                            ? (i === 0 ? '正解' : p.pattern)
                            : (i === bp ? '★' : '') + nums[i].ptxt + ' dB / SSIM ' +
                              (i === bs ? '★' : '') + nums[i].ssim.toFixed(3),
                       best: (i === bp || i === bs) });
        }
      } else {
        out = { orig: U.cloneImageData(src), bayer: bayer,
                bilinear: bil, ahd: ahd }[p.view] || ahd;
      }

      return { out: out, report: { rows: rows, tiles: tiles } };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: 'デジタルカメラのセンサは、1つの画素で1つの色しか測れません。そこで画素ごとに赤・緑・青のどれか1色だけを通すフィルタを市松に並べ（カラーフィルタ配列、Bayer 配列）、足りない2色をあとから計算で埋めます。この埋める処理がデモザイクです。\n\nつまり、私たちが見ているカラー写真は、画素の 2/3 が推測で埋められた絵だということになります。緑が半分、赤と青が 1/4 ずつなのは、人の目が緑の周波数帯に一番敏感で、明るさの手がかりの大半を緑が担っているからです。\n\nここでは原画をいったん Bayer 配列に間引いてから2つのやり方で戻し、原画と突き合わせます。ふだんは測れない「正解」が手元にあるので、どれだけ正しく埋められたかを数字で言えます。\n\nたとえるなら、虫食いだらけの楽譜を復元する作業です。バイリニアは前後の音符の平均でとりあえず埋める。AHD は「横に読んだ場合」と「縦に読んだ場合」の両方を書いてみて、前後と自然につながるほうを採ります。',
      formula: 'バイリニア（G の場合）：Ĝ(x,y) = ( G(x−1,y) + G(x+1,y) + G(x,y−1) + G(x,y+1) ) / 4\n\nAHD の方向別 G（Hamilton-Adams、横向き）：\n　Ĝ_h(x,y) = ( G(x−1,y) + G(x+1,y) ) / 2 + ( 2C(x,y) − C(x−2,y) − C(x+2,y) ) / 4\n　　C は中心画素の色（R か B）。第2項は「G と C の差が滑らかである」ことを使った補正\n\n色差の補間：R̂ = Ĝ + bilinear( R − Ĝ )　　B̂ = Ĝ + bilinear( B − Ĝ )\n\n一様性：H_d(x) = #{ y ∈ N₄(x) : |L_d(x) − L_d(y)| ≤ εL かつ ‖ab_d(x) − ab_d(y)‖² ≤ εab }\n　　εL = min( 横向きの左右差の大, 縦向きの上下差の大 )　（εab も同様）\n　　3×3 の和が大きいほうの向きを採る',
      notes: [
        '**偽色やジッパーノイズは1〜2画素の細かさで出るので、〈4分割で並べる〉では見えません。**4分割は各面を 2×2 の箱平均で半分に縮めており、その平均そのものが偽色を薄める働きをするからです（実測で、色差の誤差の平均が縮める前の 45〜58% に落ちます）。4分割は「どちらが良いか」を数値で一目で示すための表示で、粒を見るための表示ではありません。',
        '**粒を見たいときは、表示を〈バイリニア（全解像度）〉にしてキー `4`（差分表示）を押してください。**原画との差が増幅されて出るので、どこにどれだけ誤差が乗っているかがそのまま見えます。〈ゾーンプレート〉なら、外側の細かいリングのところに網目状の誤差がはっきり出ます。そのまま表示を〈AHD（全解像度）〉に切り替えると、同じ場所の誤差が目に見えて減ります。差分の倍率スライダーを上げると、弱い誤差も拾えます。',
        '色そのものを見たいときは、〈バイリニア（全解像度）〉のままキー `2`（処理後）に戻し、ルーペの倍率を 16 以上に上げて細かいところに当ててください。白黒の縞のはずのところに、緑やピンクの色が乗っているのが見えます。右下の「偽色（色差の誤差）」がその量で、〈ゾーンプレート〉では 4.35 → 1.03、〈ジーメンススター〉では 1.09 → 0.23 まで下がります。**ジーメンススターは偽色が弱い（ゾーンプレートの 1/4）ので、目で見るならゾーンプレートのほうが向いています。**',
        'ジッパーノイズは「横に読むか縦に読むか」を間違えたときに出ます。細い横線を縦向きに補間すると、線のある行と無い行を混ぜてしまい、1行おきに明るさが振れます。これが階段状の縞に見えるのでジッパーと呼ばれます。AHD が横向きと縦向きの両方を計算してから選ぶのは、この間違いを避けるためです。',
        '偽色は「明るさは合っているのに色だけ違う」形で出ます。緑は半分の画素で測れているのに、赤と青は 1/4 しかないためです。細かい模様のところでは赤と青の推測が外れ、白黒の縞にピンクや緑が乗ります。対策として色差（R−G, B−G）を補間するのが定石で、AHD もバイリニアの色差補間を土台にしています。',
        'AHD の「一様性」は、上下左右の4近傍と比べて「明るさも色も近い」ものがいくつあるかを数えたものです。正しい向きに補間できていれば模様がつながるので近傍と馴染み、間違えていれば1画素おきに暴れるので馴染みません。許容範囲（ε）を固定値ではなく、その場所の横方向・縦方向の差から作っているのがこの手法の要で、平坦なところでは厳しく、模様のあるところでは緩く判定されます。',
'「AHD の後処理（色差メディアン）」の効き目は、**〈ソルト＆ペッパーノイズ〉で〈AHD（全解像度）〉**にすると一番はっきり見えます。飛んだ画素はそこで1色しか測れていないので、戻すと**色のついた点**になります。メディアンを 0 → 1 → 3 と上げると、その色だけが消えていきます。実測（640×480）で、色差の誤差が強い画素（20階調超）が **20,885 → 3,172 → 482 画素**、平均が **6.08 → 3.41 → 1.86** まで下がります。\n\n**白黒の粒はそのまま残ります。**メディアンをかけているのは色差（R−G と B−G）だけで、明るさには触っていないからです。輝度の誤差は 6.86 → 5.59 とほとんど動きません。「色ノイズだけを消して解像感は落とさない」という、実際のカメラの絵作りでも使われる手です。\n\nただしタダではありません。同じ絵で PSNR は 21.7 → 22.9 dB と良くなる一方、SSIM は 0.882 → 0.858 とわずかに下がります。細かいものが少しだけ均されるためで、かけすぎない（既定は1回）のが無難です。\n\nなお〈ゾーンプレート〉のようにノイズの無い絵では、AHD の段階ですでに強い偽色が残っていないので（色差の誤差の最大が 14 階調）、メディアンを動かしても見た目は変わりません。',
        '「CFA の並び」を変えると結果が変わります。RGGB と BGGR は赤と青が入れ替わるだけですが、GRBG / GBRG では緑の市松が半画素ずれます。実際のカメラではセンサごとに並びが決まっており、RAW 現像ソフトはこれを読み違えると全体が変な色になります。',
        'PSNR での差は絵によって大きく変わります。640×480 の実測で、〈ジーメンススター〉が 29.4 → 37.7 dB、〈ゾーンプレート〉が 26.4 → 37.3 dB と 8〜11 dB も開くのに対し、〈低コントラスト〉では 42.7 → 46.5 dB にとどまります。細かい模様や斜めの線が多いほど「向きの選択」が効くからです。ナイキスト周波数の近くでは、どんな手法でも原理的に色を復元できない領域が残ります。',
        '〈カラーバー＋彩度グラデ〉だけは AHD が負けます（33.6 dB 対 31.8 dB）。誤差の在りかを調べると、画面の 8% にすぎない色の境界の列に集中していて、そこでの平均二乗誤差はバイリニアの 289 に対して AHD が 461 でした。方向別の G が使っている「G と R（B）の差は滑らかだ」という前提が、彩度の高い色がいきなり切り替わる縦線のところでだけ破れ、補正項が行き過ぎるためです。細かい模様には強いが、色のはっきりした段差では素朴な平均のほうが素直、という交換条件がそのまま出た例です。',
        'AHD は赤と青を対等には扱いません。RGGB の絵の赤と青を入れ替えて BGGR で解いても、結果は完全には一致しません。方向を選ぶ判定を CIELab でやっており、Lab では赤と青の重みが違うからです（バイリニアのほうは赤も青も同じ式なので、ぴたり一致します）。不具合ではなく、判定の物差しを人の感じ方に寄せたことの裏返しです。',
        'この処理は行帯に分けられないので、1つのワーカーに丸ごと渡しています。右下の「実行」欄に Worker 1 並列と出るのはそのためです。PSNR / SSIM が画像全体の集計であること、AHD の方向選択が近傍を広く見ることの2つが理由です。',
        'Bayer 配列そのものを見たいときは、表示を〈Bayer 生データ（全解像度）〉にして、**色が一様なところ**にルーペを当ててください。〈カラーバー＋彩度グラデ〉の白い帯が分かりやすく、2×2 のうち赤1・緑2・青1 が並んでいるのがはっきり見えます。細かい模様のところに当てると、下の絵の模様とモザイクが混ざって読み取れません。ルーペの倍率は 16 以上に上げてください（中央の赤枠が1画素です）。'
      ]
    }
  });
})();
