/* ImageLab — ops/gamma.js : ガンマ補正 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'gamma',
    category: 'point',
    label: 'ガンマ補正',
    params: [
      { key: 'gamma', type: 'range', label: 'γ', min: 0.1, max: 3.0, step: 0.01, value: 1.0,
        format: function (v) { return v.toFixed(2) + (v > 1 ? '（明るく）' : v < 1 ? '（暗く）' : '（変化なし）'); } },
      { key: 'mode', type: 'select', label: '対象', value: 'luma',
        options: [{ value: 'luma', label: '輝度のみ（色比を保つ）' }, { value: 'rgb', label: 'RGB個別' }] }
    ],
    apply: function (src, p) {
      var lut = new Uint8ClampedArray(256), inv = 1 / p.gamma;
      for (var i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, inv));
      return U.applyLUT(src, lut, p.mode);
    },
    doc: {
      principle: '明るさをべき乗で写し替える処理です。0〜1 に正規化した値を 1/γ 乗するので、γ を大きくすると暗部が大きく持ち上がり、明部はあまり動きません。人間の目は暗い側の差に敏感なので、この「暗部を厚く配分する」性質が理にかなっています。\n\nたとえるなら、階段の段差を一律に下げるのではなく、下の方の段だけ細かく刻み直すようなものです。踏み外しやすい足元だけ丁寧にする、という配分の変更です。',
      formula: 'g = 255 · ( f / 255 ) ^ (1/γ)\nγ > 1 … 明るく（暗部が伸びる） / γ < 1 … 暗く / γ = 1 … 恒等\n※ ソフトによっては指数を γ と書く流儀もあります。向きが逆になるので注意。',
      notes: [
        'トーンカーブの特殊な場合です。カーブを手で描く代わりに、パラメータ1個で形が決まります。デモでは「まずガンマ、次にトーンカーブ」の順で見せると理解が早いです。',
        'sRGB の画像はすでに約 2.2 のガンマがかかった状態で保存されています。物理的に正しい平均や合成をしたいときは、いったんリニアに戻してから計算する必要があります。ここでは表示値のまま処理しています（同好会でよく話題になる落とし穴）。',
        'γ を上げると暗部の階調が引き伸ばされるぶん、そこに乗っていたノイズも一緒に持ち上がります。「暗部にディテール」サンプルで確認できます。',
        'ヒストグラムの山が左右どちらへ、どう伸び縮みするかを見ると、べき乗写像の効き方が一目で分かります。'
      ]
    }
  });
})();
