/* ImageLab — ops/blur.js : 平均化 / ガウシアン平滑化 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'blur',
    category: 'spatial',
    label: '平均化 / ガウシアン',
    params: [
      { key: 'kind', type: 'select', label: '種類', value: 'gauss',
        options: [{ value: 'gauss', label: 'ガウシアン' }, { value: 'box', label: '平均化（ボックス）' }] },
      { key: 'sigma', type: 'range', label: 'σ（標準偏差）', min: 0.3, max: 12, step: 0.1, value: 2.0,
        when: function (p) { return p.kind === 'gauss'; },
        format: function (v) { return v.toFixed(1) + ' px（窓は約 ' + (2 * Math.ceil(v * 3) + 1) + ' px）'; } },
      { key: 'radius', type: 'range', label: '窓の半径', min: 1, max: 20, step: 1, value: 3,
        when: function (p) { return p.kind === 'box'; },
        format: function (v) { return v + ' px（窓は ' + (2 * v + 1) + ' × ' + (2 * v + 1) + '）'; } }
    ],
    /* 縦方向の畳み込みで、帯の上下にカーネルの半径ぶんはみ出す */
    halo: function (p) {
      return (p.kind === 'gauss') ? Math.max(1, Math.ceil(p.sigma * 3)) : p.radius;
    },

    cost: function (w, h, p) {
      var kl = (p.kind === 'gauss') ? U.gaussianKernel1d(p.sigma).length : (2 * p.radius + 1);
      return w * h * 2 * kl * 3 * 2.0e-6;
    },

    prepare: function (src, p) {
      return { k: (p.kind === 'gauss') ? U.gaussianKernel1d(p.sigma) : U.boxKernel1d(p.radius) };
    },

    /* 行帯 [y0, y1) だけを処理する。
     *
     * 分離可能なので「横 → 縦」の2段。縦の段で帯の上下 ry 行ぶんを読むので、
     * 横の段はあらかじめ [y0-ry, y1+ry) の範囲まで作っておく。
     * 画像の外へ出る行は、画像全体の高さに対して鏡映するので、
     * 帯に切っても一枚で計算したときと同じ結果になる。 */
    kernel: function (src, p, y0, y1, c) {
      var w = src.width, h = src.height, sd = src.data;
      var k = c.k, kl = k.length, r = (kl - 1) >> 1;
      var bh = y1 - y0, th = bh + 2 * r;

      var tr = new Float32Array(w * th), tg = new Float32Array(w * th), tb = new Float32Array(w * th);
      var t, x, y, i, sx, sy, q, kk, sr, sg, sb, srow, trow;

      /* --- 横方向 --- */
      for (t = 0; t < th; t++) {
        sy = U.mir(y0 - r + t, h);
        srow = sy * w * 4; trow = t * w;
        for (x = 0; x < w; x++) {
          sr = 0; sg = 0; sb = 0;
          for (i = 0; i < kl; i++) {
            sx = x + i - r;
            /* 鏡映が要るのは縁だけ。内側で U.mir を呼ぶと、そこが時間の大半を食う */
            if (sx < 0 || sx >= w) sx = U.mir(sx, w);
            q = srow + sx * 4; kk = k[i];
            sr += sd[q] * kk; sg += sd[q + 1] * kk; sb += sd[q + 2] * kk;
          }
          tr[trow + x] = sr; tg[trow + x] = sg; tb[trow + x] = sb;
        }
      }

      /* --- 縦方向。出力行 y は tmp の行 y〜y+2r に対応する --- */
      var out = new ImageData(w, bh), d = out.data;
      for (y = 0; y < bh; y++) {
        for (x = 0; x < w; x++) {
          sr = 0; sg = 0; sb = 0;
          for (i = 0; i < kl; i++) {
            q = (y + i) * w + x; kk = k[i];
            sr += tr[q] * kk; sg += tg[q] * kk; sb += tb[q] * kk;
          }
          q = (y * w + x) * 4;
          d[q] = U.clamp8(sr); d[q + 1] = U.clamp8(sg); d[q + 2] = U.clamp8(sb); d[q + 3] = 255;
        }
      }
      return out;
    },
    doc: {
      principle: '注目画素の周りを重み付きで平均する処理です。平均化は窓の中を一律の重みで、ガウシアンは中心が重く外へ行くほど軽い釣鐘型の重みで平均します。どちらも高い周波数（細かい変化）を削るローパスフィルタです。\n\nたとえるなら、アンケートの回答を近所どうしで持ち寄って平均を取るようなものです。平均化は「半径◯m 以内の人を全員同じ1票」で数え、ガウシアンは「近い人ほど重く数える」やり方です。後者のほうが、境界での不自然な切れ方が起きません。',
      formula: 'ガウシアン：G(x, y) = (1 / 2πσ²) · exp( −(x² + y²) / 2σ² )\n分離可能：G(x, y) = G(x) · G(y) なので、横1回 → 縦1回で済む\n計算量：素朴に2次元でやると O(N·k²)、分離すると O(N·2k)',
      notes: [
        'ガウシアンは分離可能実装にしてあります。σ=5 なら窓は 31×31 = 961 回の積和ですが、横31回＋縦31回の62回で同じ結果になります。15倍以上の差で、σ が大きいほど効きます。同好会で最初に見せる「実装の工夫」として分かりやすい題材です。',
        '平均化（ボックス）は窓の重みが崖のように切れているため、周波数領域では sinc 関数になり、副次的な山（リンギング）が残ります。「ゾーンプレート」サンプルにかけると、ぼけきらない同心円が半径ごとに残るのが見えます。ガウシアンではこれが起きません。',
        'ガウシアンを繰り返しかけると、σ は単純に足されず二乗和の平方根で合成されます（σ₁ と σ₂ を続けてかけると √(σ₁²+σ₂²)）。中心極限定理から、平均化を何度も繰り返してもガウシアンに近づきます。',
        '境界は reflect101（端の画素を重複させない鏡映）で埋めています。ゼロ埋めにすると画像の縁が暗くなるためです。',
        'σ を大きくすると（10 前後から）待たされるので、そこからは Web Worker に逃がして複数のコアで分担します。分担は画像を横に切った行帯ごとで、縦方向の畳み込みが帯の上下にはみ出すぶんは、隣の帯と重ねて読み直しています。この「のりしろ」があるので、分担しても結果は一枚で計算したときと変わりません。'
      ]
    }
  });
})();
