/* ImageLab — ops/unsharp.js : アンシャープマスク */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'unsharp',
    category: 'spatial',
    label: 'アンシャープマスク',
    params: [
      { key: 'amount', type: 'range', label: '量', min: 0, max: 3, step: 0.05, value: 1.0,
        format: function (v) { return Math.round(v * 100) + '%'; } },
      { key: 'sigma', type: 'range', label: '半径 σ', min: 0.3, max: 10, step: 0.1, value: 1.6,
        format: function (v) { return v.toFixed(1) + ' px'; } },
      { key: 'threshold', type: 'range', label: 'しきい値', min: 0, max: 60, step: 1, value: 0,
        format: function (v) { return v + ' 階調（これ以下の差は無視）'; } },
      { key: 'showMask', type: 'checkbox', label: '差分マスクを表示（何を足しているか）', value: false }
    ],
    apply: function (src, p) {
      var w = src.width, h = src.height;
      var pl = U.splitPlanes(src);
      var out = [null, null, null];
      var n = w * h, c, i;

      for (c = 0; c < 3; c++) {
        var blur = U.gaussianBlurPlane(pl[c], w, h, p.sigma);
        var res = new Float32Array(n);
        for (i = 0; i < n; i++) {
          var mask = pl[c][i] - blur[i];
          if (Math.abs(mask) < p.threshold) mask = 0;
          res[i] = p.showMask ? (128 + mask * p.amount) : (pl[c][i] + mask * p.amount);
        }
        out[c] = res;
      }
      return U.mergePlanes(out[0], out[1], out[2], w, h);
    },
    doc: {
      principle: '元画像から、ぼかした画像を引きます。残るのは「ぼかしで失われた成分」＝細部だけで、これを元画像に足し戻すと細部が強調されます。名前は「ぼけていないマスク」ではなく、暗室でぼかしたネガをマスクに使った古典的な手法に由来します。\n\nたとえるなら、写真から「大づかみな明暗」だけを取り除いて細かい模様を取り出し、それを元の写真に重ね刷りするようなものです。',
      formula: 'mask = f − Gσ * f\ng = f + amount · mask   （|mask| ≤ threshold の画素は mask = 0 とする）\n= (1 + a)·f − a·(Gσ * f) なので、正味は「ハイパスを足す」ことと同じ',
      notes: [
        '「ぼけた細線・格子」サンプルはあらかじめ σ=1.6 でぼかしてあります。同じ σ=1.6 を指定すると細部がよく戻ります。ぼけの大きさと半径を合わせる、という感覚を掴むのに向いています。',
        '「差分マスクを表示」にチェックを入れると、実際に足し引きしている成分そのものが見えます（128 が0）。同好会では、まずこれを見せてから足し戻すと納得されやすいです。',
        'エッジの両側に明るい／暗い縁取り（ハロー）が出ます。半径を大きくするほど太く目立ちます。過剰なシャープネスが「不自然」に見える正体はこれです。',
        'しきい値は、平坦な部分のノイズまで強調しないためのものです。0 のままだと、ノイズの多い写真では粒状感が一気に増えます。「ガウシアンノイズ＋段差」サンプルで、しきい値を上げていくと効果が分かります。',
        '実は「元画像 − ぼかし」はラプラシアンの近似です。σ の違う2つのガウシアンの差（DoG）とも近い関係にあり、エッジ検出の Laplacian や LoG と地続きの処理です。'
      ]
    }
  });
})();
