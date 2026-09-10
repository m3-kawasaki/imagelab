/* ImageLab — ops/sobel.js : Sobel / Prewitt / Scharr */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  /* どれも「片方向に微分、直交方向に平滑化」という同じ骨格で、
     平滑化側の重みだけが違う。だから分離可能に書ける。 */
  var SMOOTH = {
    sobel:   new Float32Array([1, 2, 1]),
    prewitt: new Float32Array([1, 1, 1]),
    scharr:  new Float32Array([3, 10, 3])
  };
  var DERIV = new Float32Array([-1, 0, 1]);

  /* 共有：勾配を計算して {gx, gy, mag} を返す（Canny からも使う） */
  IL.gradient = function (gray, w, h, kind) {
    var sm = SMOOTH[kind] || SMOOTH.sobel;
    var gx = U.convolveSeparable(gray, w, h, DERIV, sm);
    var gy = U.convolveSeparable(gray, w, h, sm, DERIV);
    var mag = new Float32Array(w * h);
    for (var i = 0; i < mag.length; i++) mag[i] = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    return { gx: gx, gy: gy, mag: mag };
  };

  IL.defineOp({
    id: 'sobel',
    category: 'edge',
    label: 'Sobel / Prewitt',
    params: [
      { key: 'kind', type: 'select', label: '演算子', value: 'sobel',
        options: [{ value: 'sobel', label: 'Sobel（1:2:1）' },
                  { value: 'prewitt', label: 'Prewitt（1:1:1）' },
                  { value: 'scharr', label: 'Scharr（3:10:3）' }] },
      { key: 'show', type: 'select', label: '表示', value: 'mag',
        options: [{ value: 'mag', label: '勾配強度 |∇f|' },
                  { value: 'gx', label: 'X方向の微分（横のエッジ検出）' },
                  { value: 'gy', label: 'Y方向の微分（縦のエッジ検出）' },
                  { value: 'dir', label: '勾配方向（色相）＋強度（明るさ）' }] },
      { key: 'gain', type: 'range', label: '表示ゲイン', min: 0.2, max: 8, step: 0.1, value: 1.0,
        format: function (v) { return '×' + v.toFixed(1); } }
    ],
    apply: function (src, p) {
      var w = src.width, h = src.height;
      var gray = U.toGrayPlane(src);
      var G = IL.gradient(gray, w, h, p.kind);
      var n = w * h, i, out;

      if (p.show === 'dir') {
        out = new ImageData(w, h);
        var d = out.data, maxm = 0;
        for (i = 0; i < n; i++) if (G.mag[i] > maxm) maxm = G.mag[i];
        maxm = maxm || 1;
        for (i = 0; i < n; i++) {
          var ang = Math.atan2(G.gy[i], G.gx[i]) * 180 / Math.PI;
          if (ang < 0) ang += 360;
          var v = U.clamp(G.mag[i] / maxm * p.gain, 0, 1);
          var c = U.hsvToRgb(ang, 1, v);   /* js/fft.js が U に置いている */
          var j = i * 4;
          d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = 255;
        }
        return out;
      }

      var plane = new Float32Array(n);
      if (p.show === 'mag') {
        for (i = 0; i < n; i++) plane[i] = G.mag[i] * p.gain;
      } else {
        /* 符号付きなので 128 を0として表示する */
        var g = (p.show === 'gx') ? G.gx : G.gy;
        for (i = 0; i < n; i++) plane[i] = 128 + g[i] * p.gain * 0.5;
      }
      return U.grayToImageData(plane, w, h);
    },
    doc: {
      principle: '明るさの変化率（1階微分）を求めます。ノイズがあると素の差分は暴れるので、微分する方向と直交する方向に平滑化を掛け合わせた 3×3 の窓を使います。Sobel は平滑化の重みが 1:2:1、Prewitt は 1:1:1、Scharr は 3:10:3 で、この重み以外は同じ骨格です。\n\nたとえるなら、坂の傾きを測るのに、1歩ぶんの高低差だけで判断せず、横に少し幅を取って均してから測るようなものです。足元の小石（ノイズ）に振り回されずに済みます。',
      formula: 'Sobel_x = [−1 0 +1; −2 0 +2; −1 0 +1] = [1 2 1]ᵀ ⊗ [−1 0 +1]\n|∇f| = √(gx² + gy²)、  方向 θ = atan2(gy, gx)\n分離可能なので 3×3 でも積和は 9 回でなく 6 回で済む',
      notes: [
        '「勾配方向」表示は、色相が向きを、明るさが強さを表します。「幾何図形」サンプルで見ると、円の周りで色相が一周し、平行な直線が同じ色になるのが分かります。方向という情報が実在することを見せるのに一番効く表示です。',
        'X方向の微分は「縦のエッジ」に反応します（横方向に値が変化しているから）。ここは同好会でも毎回ひっかかる点なので、gx と gy を切り替えて見せると早いです。',
        'Scharr は 3×3 の枠の中で回転対称性が最も良くなるよう重みを決めたもので、斜めのエッジで角度誤差が小さくなります。斜線の束を「勾配方向」で見ると差が出ます。',
        '1階微分はエッジの「位置」ではなく「強さ」を返します。太い帯として出るので、細い線に絞るには非極大抑制が要ります。それをやるのが Canny です。',
        '実務では、この勾配強度をそのまま閾値処理してエッジとする場面も多く、その場合は照明ムラに弱いという弱点がついて回ります。'
      ]
    }
  });
})();
