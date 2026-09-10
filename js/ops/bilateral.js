/* ImageLab — ops/bilateral.js : バイラテラルフィルタ */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'bilateral',
    category: 'spatial',
    label: 'バイラテラル',
    params: [
      { key: 'sigmaS', type: 'range', label: 'σ_space（距離）', min: 0.5, max: 8, step: 0.1, value: 3.0,
        format: function (v) { return v.toFixed(1) + ' px（窓は約 ' + (2 * Math.ceil(v * 2) + 1) + ' px）'; } },
      { key: 'sigmaC', type: 'range', label: 'σ_color（値の差）', min: 2, max: 100, step: 1, value: 30,
        format: function (v) { return v + ' 階調'; } },
      { key: 'metric', type: 'select', label: '値の差の測り方', value: 'luma',
        options: [{ value: 'luma', label: '輝度差（色ずれが出にくい）' },
                  { value: 'rgb', label: 'RGB のユークリッド距離' }] }
    ],
    /* 窓の半径ぶん、帯の外を読む */
    halo: function (p) { return Math.min(10, Math.ceil(p.sigmaS * 2)); },

    /* Worker に回すかどうかの判断用。定数は docs/_bench.js の実測から起こした
       ざっくりした係数で、桁が合っていれば足りる */
    cost: function (w, h, p) {
      var win = 2 * Math.min(10, Math.ceil(p.sigmaS * 2)) + 1;
      return w * h * win * win * 1.16e-5;
    },

    /* 重みの表とプレーンは帯をまたいで使い回せるので、ここで一度だけ作る */
    prepare: function (src, p) {
      var r = Math.min(10, Math.ceil(p.sigmaS * 2));
      var win = 2 * r + 1;

      /* 距離の重みは窓の形で決まるので、先に一度だけ作る */
      var sw = new Float32Array(win * win);
      var i, dx, dy;
      for (dy = -r; dy <= r; dy++) {
        for (dx = -r; dx <= r; dx++) {
          sw[(dy + r) * win + (dx + r)] = Math.exp(-(dx * dx + dy * dy) / (2 * p.sigmaS * p.sigmaS));
        }
      }
      /* 値の差の重みも表引きにする（exp を毎回呼ぶと桁違いに遅い） */
      var maxD = (p.metric === 'rgb') ? 442 : 256;
      var cw = new Float32Array(maxD + 1);
      for (i = 0; i <= maxD; i++) cw[i] = Math.exp(-(i * i) / (2 * p.sigmaC * p.sigmaC));

      /* RGB を連続した3枚のプレーンに分けておく。
         ImageData を4バイト飛びで読むより素直で、キャッシュにも乗りやすい */
      var pl = U.splitPlanes(src);
      return { r: r, win: win, sw: sw, cw: cw,
               pr: pl[0], pg: pl[1], pb: pl[2], lum: U.toGrayPlane(src) };
    },

    /* 行帯 [y0, y1) だけを処理する。
       読むほうは画像全体なので、結果は一枚で計算したときと一致する。 */
    kernel: function (src, p, y0, y1, c) {
      var w = src.width, h = src.height;
      var r = c.r, win = c.win, sw = c.sw, cw = c.cw;
      var pr = c.pr, pg = c.pg, pb = c.pb, lum = c.lum;
      var useLuma = (p.metric === 'luma');
      var out = new ImageData(w, y1 - y0), d = out.data;

      /* 内側と縁で処理を分けている。
         内側は鏡映（U.mir）が要らないので、添字を直接足すだけで済む。
         窓が 13×13 なら1画素あたり169回ぶんの判定が消えるので効果が大きい。
         分岐を最内ループの外へ出したいので、あえて同じ形のループを2つ書いている。 */
      var y, x, k, dx, dy, diff, wgt, er, eg, eb, swRow, lineBase;
      for (y = y0; y < y1; y++) {
        var inRow = (y >= r && y < h - r);
        for (x = 0; x < w; x++) {
          var idx = y * w + x, o = ((y - y0) * w + x) * 4;
          var cr = pr[idx], cg = pg[idx], cb = pb[idx], cy = lum[idx];
          var ar = 0, ag = 0, ab = 0, wsum = 0;

          if (inRow && x >= r && x < w - r) {
            for (dy = -r; dy <= r; dy++) {
              swRow = (dy + r) * win + r;
              lineBase = (y + dy) * w + x;
              for (dx = -r; dx <= r; dx++) {
                k = lineBase + dx;
                if (useLuma) { diff = lum[k] - cy; if (diff < 0) diff = -diff; }
                else {
                  er = pr[k] - cr; eg = pg[k] - cg; eb = pb[k] - cb;
                  diff = Math.sqrt(er * er + eg * eg + eb * eb);
                }
                wgt = sw[swRow + dx] * cw[diff | 0];
                ar += pr[k] * wgt; ag += pg[k] * wgt; ab += pb[k] * wgt;
                wsum += wgt;
              }
            }
          } else {
            for (dy = -r; dy <= r; dy++) {
              swRow = (dy + r) * win + r;
              lineBase = U.mir(y + dy, h) * w;
              for (dx = -r; dx <= r; dx++) {
                k = lineBase + U.mir(x + dx, w);
                if (useLuma) { diff = lum[k] - cy; if (diff < 0) diff = -diff; }
                else {
                  er = pr[k] - cr; eg = pg[k] - cg; eb = pb[k] - cb;
                  diff = Math.sqrt(er * er + eg * eg + eb * eb);
                }
                wgt = sw[swRow + dx] * cw[diff | 0];
                ar += pr[k] * wgt; ag += pg[k] * wgt; ab += pb[k] * wgt;
                wsum += wgt;
              }
            }
          }

          d[o] = U.clamp8(ar / wsum);
          d[o + 1] = U.clamp8(ag / wsum);
          d[o + 2] = U.clamp8(ab / wsum);
          d[o + 3] = 255;
        }
      }
      return out;
    },

    doc: {
      principle: 'ガウシアン平滑化の重みに、もう一つ「値がどれだけ違うか」の重みを掛けます。近くにあっても値が大きく違う画素（＝エッジの向こう側）はほとんど平均に参加しません。結果として、平坦な部分のノイズだけが消え、エッジは立ったまま残ります。\n\nたとえるなら、近所の人の意見を聞くときに「距離が近い人」だけでなく「自分と意見が近い人」の声を重く採る合議です。道の向こう側の反対意見に引きずられないので、立場の境目がぼやけません。',
      formula: 'g(p) = (1/W) Σ_q f(q) · exp( −‖p−q‖² / 2σ_s² ) · exp( −|f(p)−f(q)|² / 2σ_c² )\nW = Σ_q （同じ2つの重みの積）\n重みが画素ごとに変わるので線形ではなく、分離もできない → O(N·k²) が基本',
      notes: [
        '「ガウシアンノイズ＋段差」サンプルで、ガウシアンと切り替えてください。ガウシアンは段差を一緒になまらせますが、バイラテラルは段差を残したままノイズを削ります。この一点がバイラテラルの価値です。',
        'σ_color を大きくすると値の差の重みが効かなくなり、ただのガウシアンに近づきます。逆に小さくしすぎると何も平均されず、恒等写像に近づきます。ノイズの標準偏差の2倍前後が目安です。',
        'σ_color を中途半端に上げると、エッジ付近に絵の具を塗ったような平板な質感（いわゆる「のっぺり」）が出ます。過去10年の美肌処理でよく見た副作用で、強くかけたときの見え方も含めて見せると説得力があります。',
        '分離できないうえ重みが画素ごとに変わるため、素直に書くと重い処理です。ここでは重みを表引きにし、窓を σ_space の2倍で打ち切っていますが、それでも1スレッドなら 640×480・σ_space=3 で約0.6秒、σ_space=6 では約1.4秒かかります。この処理集の中で群を抜いて重い処理です。',
        '重いので Web Worker に逃がしてあります。画像を横に切って行帯に分け、複数のコアで同時に計算しています。計算量そのものは変わりませんが、待っている間も画面が固まらず、12コア機で3〜4倍速くなります。「逐次表示」をオンにすると、処理済みの帯が上から順に降りてくるのが見えます — 分担のしかたがそのまま画面に出るので、並列化の説明にそのまま使えます。',
        '重いのは工夫不足ではなく、計算量そのものが O(N·k²) だからです。0.31 メガ画素 × 13×13 の窓で、内側のループが5千万回以上回ります。根本的に速くするには双方向グリッド（bilateral grid）や permutohedral lattice のように、計算の仕組みごと変える必要があります。',
        '「輝度差」を選ぶと、色ノイズがあっても平均の重みが安定します。「RGB距離」は原典に忠実ですが、彩度の高い境界で挙動が変わります。両方を切り替えて比べられるようにしてあります。'
      ]
    }
  });
})();
