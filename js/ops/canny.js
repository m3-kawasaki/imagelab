/* ImageLab — ops/canny.js : Canny エッジ検出（途中経過を段階表示できる） */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'canny',
    category: 'edge',
    label: 'Canny（段階表示つき）',
    params: [
      { key: 'stage', type: 'select', label: '表示する段階', value: 'final',
        options: [{ value: 's1', label: '① 平滑化後' },
                  { value: 's2', label: '② 勾配強度' },
                  { value: 's3', label: '③ 勾配方向（4方向に量子化）' },
                  { value: 's4', label: '④ 非極大抑制の後' },
                  { value: 's5', label: '⑤ 二重閾値（白＝強 / 灰＝弱）' },
                  { value: 'final', label: '⑥ ヒステリシス後（最終結果）' }] },
      { key: 'sigma', type: 'range', label: 'σ（平滑化）', min: 0.4, max: 6, step: 0.1, value: 1.4,
        format: function (v) { return v.toFixed(1) + ' px'; } },
      { key: 'low', type: 'range', label: '下側しきい値', min: 0, max: 255, step: 1, value: 20 },
      { key: 'high', type: 'range', label: '上側しきい値', min: 0, max: 255, step: 1, value: 55 }
    ],
    apply: function (src, p) {
      var w = src.width, h = src.height, n = w * h, i, x, y;

      /* ① 平滑化 */
      var gray = U.toGrayPlane(src);
      var sm = U.gaussianBlurPlane(gray, w, h, p.sigma);
      if (p.stage === 's1') return U.grayToImageData(sm, w, h);

      /* ② 勾配（Sobel）。しきい値を 0..255 で指定できるよう最大値で正規化する */
      var G = IL.gradient(sm, w, h, 'sobel');
      var maxm = 0;
      for (i = 0; i < n; i++) if (G.mag[i] > maxm) maxm = G.mag[i];
      var scale = maxm > 0 ? 255 / maxm : 0;
      var mag = new Float32Array(n);
      for (i = 0; i < n; i++) mag[i] = G.mag[i] * scale;
      if (p.stage === 's2') return U.grayToImageData(mag, w, h);

      /* 方向を 0°/45°/90°/135° の4つに丸める */
      var dir = new Uint8Array(n);
      for (i = 0; i < n; i++) {
        var a = Math.atan2(G.gy[i], G.gx[i]) * 180 / Math.PI;
        if (a < 0) a += 180;
        dir[i] = (a < 22.5 || a >= 157.5) ? 0 : (a < 67.5) ? 1 : (a < 112.5) ? 2 : 3;
      }
      if (p.stage === 's3') {
        var cols = [[255, 90, 90], [255, 210, 80], [110, 220, 130], [120, 170, 255]];
        var od = new ImageData(w, h), dd = od.data;
        for (i = 0; i < n; i++) {
          var t = U.clamp(mag[i] / 60, 0, 1), c = cols[dir[i]], j = i * 4;
          dd[j] = c[0] * t; dd[j + 1] = c[1] * t; dd[j + 2] = c[2] * t; dd[j + 3] = 255;
        }
        return od;
      }

      /* ④ 非極大抑制：勾配の向きに沿った両隣より強くない画素を捨て、
            太い帯だったエッジを1画素幅の稜線に削る */
      var nms = new Float32Array(n);
      var off = [[1, 0], [1, -1], [0, -1], [-1, -1]];   /* 各方向での「隣」 */
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var o = off[dir[i]];
          var ax = x + o[0], ay = y + o[1], bx = x - o[0], by = y - o[1];
          var va = (ax < 0 || ay < 0 || ax >= w || ay >= h) ? 0 : mag[ay * w + ax];
          var vb = (bx < 0 || by < 0 || bx >= w || by >= h) ? 0 : mag[by * w + bx];
          nms[i] = (mag[i] >= va && mag[i] >= vb) ? mag[i] : 0;
        }
      }
      if (p.stage === 's4') return U.grayToImageData(nms, w, h);

      /* ⑤ 二重閾値 */
      var lo = Math.min(p.low, p.high), hi = Math.max(p.low, p.high);
      var lab = new Uint8Array(n);            /* 0=無し 1=弱 2=強 */
      for (i = 0; i < n; i++) lab[i] = nms[i] >= hi ? 2 : (nms[i] >= lo ? 1 : 0);
      if (p.stage === 's5') {
        var o5 = new ImageData(w, h), d5 = o5.data;
        for (i = 0; i < n; i++) {
          var v5 = lab[i] === 2 ? 255 : (lab[i] === 1 ? 110 : 0), j5 = i * 4;
          d5[j5] = v5; d5[j5 + 1] = v5; d5[j5 + 2] = v5; d5[j5 + 3] = 255;
        }
        return o5;
      }

      /* ⑥ ヒステリシス：強エッジから8近傍をたどり、繋がっている弱エッジだけ残す */
      var keep = new Uint8Array(n);
      var stack = new Int32Array(n), sp = 0;
      for (i = 0; i < n; i++) if (lab[i] === 2) { keep[i] = 1; stack[sp++] = i; }
      while (sp > 0) {
        var cur = stack[--sp];
        var cx = cur % w, cy = (cur / w) | 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = cy + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = cx + dx; if (xx < 0 || xx >= w) continue;
            var k = yy * w + xx;
            if (!keep[k] && lab[k] === 1) { keep[k] = 1; stack[sp++] = k; }
          }
        }
      }
      var out = new ImageData(w, h), d = out.data;
      for (i = 0; i < n; i++) {
        var v = keep[i] ? 255 : 0, j = i * 4;
        d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255;
      }
      return out;
    },
    doc: {
      principle: '1986年に John Canny が「良い検出・良い位置決め・1本の応答」という3つの条件から導いた手順です。①ガウシアンで平滑化 →②勾配を求める →③方向に沿って非極大を抑制し1画素幅にする →④2つのしきい値で強／弱に分ける →⑤強エッジと繋がっている弱エッジだけを残す、の5段構えになっています。\n\nたとえるなら、山の稜線を地図に引く作業です。まず等高線を滑らかにし、傾きを測り、尾根の頂点だけを残し、はっきりした尾根を確実に採用したうえで、そこから続いている自信のない部分も辿って繋ぎます。',
      formula: '① S = Gσ * f\n② gx, gy = Sobel(S)、|∇S| = √(gx²+gy²)、θ = atan2(gy, gx)\n③ NMS：|∇S|(p) が θ 方向の両隣以上でなければ 0\n④ 強 = |∇S| ≥ high、弱 = low ≤ |∇S| < high\n⑤ 強に8連結で繋がる弱だけを残す',
      notes: [
        '「表示する段階」を①から順に切り替えると、なぜこの手順が必要なのかが1つずつ分かります。同好会ではこの順に見せるのが一番効きます。とくに③→④で太い帯が1本の線に痩せる瞬間が山場です。',
        'しきい値は勾配強度の最大値を255に正規化した値で指定しています。画像ごとに絶対値が大きく変わるので、この正規化がないとスライダーの目盛りが意味を持ちません。実装によっては大津の方法などで自動決定します。',
        'high : low は 2:1〜3:1 が経験則です。⑤の表示で灰色（弱エッジ）がどこに散らばっているかを見てから⑥に切り替えると、ヒステリシスが何を拾い何を捨てたかが分かります。',
        'σ を上げるとノイズに強くなる代わりに、エッジの位置がずれ、近接した2本のエッジが融合します。検出性能と位置精度はトレードオフだ、というのが Canny の議論の核心部分です。',
        '非極大抑制で見ている「隣」は、勾配方向を4つに丸めた先の画素です。より正確にやるなら、方向に沿って線形補間した値と比べます。ここでは実装が読めることを優先して丸めています。',
        '出力は2値の線画なので、この後は輪郭追跡やハフ変換に渡すのが定番の流れです。'
      ]
    }
  });
})();
