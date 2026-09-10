/* ImageLab — ops/tone.js : トーンカーブ */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  /* 単調保存の3次補間（PCHIP）。
   * 普通のスプラインだと制御点の間で行き過ぎ（オーバーシュート）が起き、
   * 明るくしたはずの階調が途中で暗くなる。それを避けるために傾きを制限する。 */
  U.curveLUT = function (points) {
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0]; });
    /* 端を必ず含める（0 と 255 が無いと外挿になる） */
    if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
    if (pts[pts.length - 1][0] < 255) pts.push([255, pts[pts.length - 1][1]]);

    var n = pts.length, i;
    var h = new Float64Array(n - 1), del = new Float64Array(n - 1);
    for (i = 0; i < n - 1; i++) {
      h[i] = Math.max(1e-6, pts[i + 1][0] - pts[i][0]);
      del[i] = (pts[i + 1][1] - pts[i][1]) / h[i];
    }
    var m = new Float64Array(n);
    if (n === 2) { m[0] = m[1] = del[0]; }
    else {
      m[0] = del[0]; m[n - 1] = del[n - 2];
      for (i = 1; i < n - 1; i++) {
        if (del[i - 1] * del[i] <= 0) { m[i] = 0; }
        else {
          var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
          m[i] = (w1 + w2) / (w1 / del[i - 1] + w2 / del[i]);
        }
      }
    }

    var lut = new Uint8ClampedArray(256), seg = 0;
    for (var x = 0; x < 256; x++) {
      while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
      var t = (x - pts[seg][0]) / h[seg];
      if (t < 0) t = 0; if (t > 1) t = 1;
      var t2 = t * t, t3 = t2 * t;
      var y = (2 * t3 - 3 * t2 + 1) * pts[seg][1]
            + (t3 - 2 * t2 + t) * h[seg] * m[seg]
            + (-2 * t3 + 3 * t2) * pts[seg + 1][1]
            + (t3 - t2) * h[seg] * m[seg + 1];
      lut[x] = Math.round(y);
    }
    return lut;
  };

  IL.defineOp({
    id: 'tone',
    category: 'point',
    label: 'トーンカーブ',
    params: [
      { key: 'curve', type: 'curve', label: 'カーブ（点をドラッグ／空白をクリックで追加／右クリックで削除）',
        value: [[0, 0], [255, 255]] },
      { key: 'mode', type: 'select', label: '対象', value: 'luma',
        options: [{ value: 'luma', label: '輝度のみ（色比を保つ）' }, { value: 'rgb', label: 'RGB個別' }] }
    ],
    apply: function (src, p) {
      return U.applyLUT(src, U.curveLUT(p.curve), p.mode);
    },
    doc: {
      principle: '入力の明るさ 0〜255 を、出力の明るさ 0〜255 へ写す「対応表（LUT）」を手で描く処理です。カーブが対角線より上にある区間は明るく、下にある区間は暗くなり、傾きが急な区間ほどコントラストが強くなります。周りの画素を一切見ないので、これは点処理の代表例です。\n\nたとえるなら、音量つまみを「小さい音・普通の音・大きい音」で別々に設定できるイコライザです。全体の音量を上げるのではなく、どの音量帯をどれだけ持ち上げるかを決めます。',
      formula: 'g(x, y) = T( f(x, y) )   T は 0..255 → 0..255 の単調写像\nLUT を1本作れば、あとは全画素で表引きするだけ（O(N)、画像サイズに比例）',
      notes: [
        '補間には単調保存の3次補間（PCHIP）を使っています。普通のスプラインだと制御点の間で行き過ぎが起き、持ち上げたはずの階調が途中で下がることがあるためです。',
        'S字カーブは中間調の傾きを立てるので「メリハリが出た」ように見えますが、その代わり両端（暗部・明部）の傾きが寝て階調が潰れます。ヒストグラムの両端がどう潰れるかを見ながら調整してください。',
        '「RGB個別」を選ぶと色かぶりの補正ができる反面、色相がねじれます。明るさだけを動かしたいときは「輝度のみ」が安全です。',
        '8bit のまま持ち上げると、間引かれた階調が戻らずヒストグラムに櫛の歯状の隙間ができます。下のヒストグラムで確認できます。'
      ]
    }
  });
})();
