/* ImageLab — ops/laplacian.js : Laplacian / LoG */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  var K4 = new Float32Array([0, 1, 0, 1, -4, 1, 0, 1, 0]);
  var K8 = new Float32Array([1, 1, 1, 1, -8, 1, 1, 1, 1]);

  IL.defineOp({
    id: 'laplacian',
    category: 'edge',
    label: 'Laplacian / LoG',
    params: [
      { key: 'kind', type: 'select', label: '種類', value: 'log',
        options: [{ value: 'k4', label: 'Laplacian（4近傍）' },
                  { value: 'k8', label: 'Laplacian（8近傍）' },
                  { value: 'log', label: 'LoG（ガウシアンで平滑化してから）' }] },
      { key: 'sigma', type: 'range', label: 'σ（LoG の平滑化）', min: 0.4, max: 8, step: 0.1, value: 1.6,
        when: function (p) { return p.kind === 'log'; },
        format: function (v) { return v.toFixed(1) + ' px'; } },
      { key: 'show', type: 'select', label: '表示', value: 'signed',
        options: [{ value: 'signed', label: '符号付き（128 が 0）' },
                  { value: 'abs', label: '絶対値' },
                  { value: 'zero', label: 'ゼロ交差（エッジ位置）' }] },
      { key: 'gain', type: 'range', label: '表示ゲイン', min: 0.5, max: 20, step: 0.5, value: 4.0,
        when: function (p) { return p.show !== 'zero'; },
        format: function (v) { return '×' + v.toFixed(1); } },
      { key: 'zthresh', type: 'range', label: 'ゼロ交差の最小段差', min: 0, max: 30, step: 0.5, value: 4,
        when: function (p) { return p.show === 'zero'; },
        format: function (v) { return v.toFixed(1); } }
    ],
    apply: function (src, p) {
      var w = src.width, h = src.height, n = w * h, i;
      var gray = U.toGrayPlane(src);
      if (p.kind === 'log') gray = U.gaussianBlurPlane(gray, w, h, p.sigma);
      var lap = U.convolve2d(gray, w, h, (p.kind === 'k8') ? K8 : K4, 3, 3);

      if (p.show === 'zero') {
        var out = new ImageData(w, h), d = out.data;
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            var idx = y * w + x, v = lap[idx], edge = false;
            /* 右と下だけ見れば、すべての隣接ペアを一度ずつ調べたことになる */
            if (x + 1 < w) {
              var vr = lap[idx + 1];
              if ((v > 0) !== (vr > 0) && Math.abs(v - vr) > p.zthresh) edge = true;
            }
            if (!edge && y + 1 < h) {
              var vd = lap[idx + w];
              if ((v > 0) !== (vd > 0) && Math.abs(v - vd) > p.zthresh) edge = true;
            }
            var j = idx * 4, c = edge ? 255 : 0;
            d[j] = c; d[j + 1] = c; d[j + 2] = c; d[j + 3] = 255;
          }
        }
        return out;
      }

      var plane = new Float32Array(n);
      if (p.show === 'abs') { for (i = 0; i < n; i++) plane[i] = Math.abs(lap[i]) * p.gain; }
      else { for (i = 0; i < n; i++) plane[i] = 128 + lap[i] * p.gain * 0.5; }
      return U.grayToImageData(plane, w, h);
    },
    doc: {
      principle: '2階微分をとります。1階微分（Sobel）がエッジで山になるのに対し、2階微分はエッジの手前で正、向こう側で負になり、エッジのちょうど真上で 0 を横切ります。この「ゼロ交差」がエッジの位置を1画素の精度で示します。方向を持たない（回転対称に近い）のも特徴です。\n\nたとえるなら、坂道を車で走ったときの「傾き」ではなく「体にかかる前後の揺れ」を見るようなものです。坂の始まりで押しつけられ、終わりで引かれ、坂の真ん中では揺れがゼロになります。',
      formula: '∇²f = ∂²f/∂x² + ∂²f/∂y²\n4近傍：[0 1 0; 1 −4 1; 0 1 0]   8近傍：[1 1 1; 1 −8 1; 1 1 1]\nLoG：∇²(Gσ * f) = (∇²Gσ) * f   … 平滑化と微分の順序は交換できる',
      notes: [
        '2階微分はノイズに非常に弱いので、素の Laplacian を実画像にかけるとほぼノイズしか出ません。先にガウシアンで平滑化する LoG が実用形です。σ を 0.4 から上げていくと、ノイズが引っ込んで構造が出てくる様子が見えます。',
        '「平滑化してから微分」と「微分したガウシアンを畳み込む」は数学的に同じです（畳み込みの結合則）。実装ではどちらを選んでもよく、ここでは前者を使っています。',
        'ゼロ交差表示は閉じた輪郭を作りやすい一方、コントラストが弱い場所でも律儀にエッジを引きます。「最小段差」で弱い交差を捨てられるようにしてあります。',
        'LoG は σ の違う2つのガウシアンの差（DoG）で近似でき、それが SIFT のキーポイント検出に使われています。アンシャープマスクの差分マスクとも兄弟関係で、同じ道具が用途によって名前を変えている例です。',
        '8近傍は斜め方向にも反応するぶん感度が高く、そのぶんノイズも拾います。4近傍と切り替えて比べてください。'
      ]
    }
  });
})();
