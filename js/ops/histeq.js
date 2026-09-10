/* ImageLab — ops/histeq.js : ヒストグラム平坦化 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  /* 累積度数から「累積を直線にする」LUT を作る */
  function cdfLUT(hist, total) {
    var lut = new Uint8ClampedArray(256), acc = 0, i;
    var cmin = 0;
    for (i = 0; i < 256; i++) { if (hist[i]) { cmin = hist[i]; break; } }
    var denom = Math.max(1, total - cmin);
    for (i = 0; i < 256; i++) {
      acc += hist[i];
      lut[i] = Math.round((acc - cmin) / denom * 255);
    }
    return lut;
  }

  function blendLUT(lut, amount) {
    var out = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) out[i] = Math.round(i + (lut[i] - i) * amount);
    return out;
  }

  IL.defineOp({
    id: 'histeq',
    category: 'point',
    label: 'ヒストグラム平坦化',
    params: [
      { key: 'mode', type: 'select', label: '対象', value: 'luma',
        options: [{ value: 'luma', label: '輝度のみ（色比を保つ）' }, { value: 'rgb', label: 'RGB個別' }] },
      { key: 'amount', type: 'range', label: '強さ', min: 0, max: 1, step: 0.01, value: 1.0,
        format: function (v) { return Math.round(v * 100) + '%'; } }
    ],
    apply: function (src, p) {
      var total = src.width * src.height;
      if (p.mode === 'rgb') {
        var h = U.histogramRGB(src);
        var lr = blendLUT(cdfLUT(h.r, total), p.amount);
        var lg = blendLUT(cdfLUT(h.g, total), p.amount);
        var lb = blendLUT(cdfLUT(h.b, total), p.amount);
        var out = new ImageData(src.width, src.height), d = out.data, s = src.data;
        for (var i = 0, j = 0; i < total; i++, j += 4) {
          d[j] = lr[s[j]]; d[j + 1] = lg[s[j + 1]]; d[j + 2] = lb[s[j + 2]]; d[j + 3] = 255;
        }
        return out;
      }
      var hy = U.histogramRGB(src).y;
      return U.applyLUT(src, blendLUT(cdfLUT(hy, total), p.amount), 'luma');
    },
    doc: {
      principle: '画像全体のヒストグラムを見て、累積度数がまっすぐな直線になるように明るさを割り当て直す処理です。画素の多い明度帯には広い出力範囲を、画素の少ない明度帯には狭い出力範囲を配ります。結果として、混み合っていた階調が引き伸ばされてコントラストが立ちます。\n\nたとえるなら、席の埋まり方に合わせて座席の幅を配り直すことです。満員の車両は幅を広げ、がらがらの車両は詰める。合計の長さは変えずに、混雑を均します。',
      formula: 'g = round( 255 · ( CDF(f) − CDF_min ) / ( N − CDF_min ) )\nCDF(v) = Σ_{k ≤ v} hist(k)、N は総画素数',
      notes: [
        '強さを 100% にすると効きすぎることが多いので、実務では 30〜60% で混ぜるのが普通です。このスライダーは「元の恒等写像との線形補間」で実装しています。',
        '全画素で1本の LUT を作る「大域的な」手法なので、画面の一部だけ極端に明るい／暗い画像は苦手です。「低コントラスト（暗部にディテール）」サンプルで試すと、右上の明るい窓が飛ぶのが見えます。その弱点を埋めるのが次の CLAHE です。',
        '平坦化後のヒストグラムは、教科書の絵のようには平らになりません。8bit の離散値では同じ値の画素をまとめて動かすしかなく、山が間引かれて櫛の歯状になります。下のグラフで確認できます。',
        '「RGB個別」は各チャンネルを独立に伸ばすため、色かぶりが強い写真では色が派手に転びます。デモでは「カラーバー」サンプルで両方を比べると違いが分かりやすいです。'
      ]
    }
  });
})();
