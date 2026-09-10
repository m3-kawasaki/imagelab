/* ImageLab — ops/fftmask.js : スペクトルマスク（手で塗って逆 FFT）
 *
 * この処理集の目玉。右パネルのスペクトルを筆で塗り、塗ったところを遮ってから
 * 逆変換する。式では書けない形（斜めの輝線だけ、輝点1組だけ、など）を
 * その場で狙って消せる。
 *
 * マスクは画像の大きさに依存しない固定の格子（既定 128×128）で持つ。
 * 正規化周波数 −0.5〜0.5 を等分したもので、作業解像度を変えても塗り直しは要らない。
 * 格子の細かさはマスク配列の長さから割り出す（Worker 側では IL を参照できないため）。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'fftmask',
    category: 'freq',
    label: 'スペクトルマスク（手で塗る）',
    params: [
      { key: 'mask', type: 'spectrum',
        label: 'スペクトル（ドラッグで遮る／右ドラッグで戻す）',
        value: function () {
          var g = IL.MASK_GRID, m = new Uint8Array(g * g);
          m.fill(255);                      /* 255 = 通す、0 = 遮る */
          return m;
        } },
      { key: 'soft', type: 'range', label: 'マスクの縁のぼかし', min: 0, max: 10, step: 1, value: 2,
        format: function (v) { return v === 0 ? '0（崖のように切る）' : v + ' 格子'; } },
      { key: 'invert', type: 'checkbox', label: '反転（塗ったところだけ通す）', value: false },
      { key: 'channels', type: 'select', label: '対象', value: 'rgb',
        options: [{ value: 'rgb', label: 'RGB 個別（色のまま処理）' },
                  { value: 'luma', label: '輝度のみ（3倍速い）' }] },
      { key: 'edge', type: 'select', label: '境界処理（2の冪への埋め方）', value: 'reflect',
        options: [{ value: 'reflect', label: '鏡映で埋める（既定）' },
                  { value: 'zero', label: 'ゼロで埋める' }] },
      { key: 'show', type: 'select', label: 'ビューアに出すもの', value: 'image',
        options: [{ value: 'image', label: '処理後の画像' },
                  { value: 'spectrum', label: 'マスクを掛けたあとのスペクトル' }] }
    ],

    halo: function () { return 1e9; },   /* 帯に分けられない（ops/fft.js の注記を参照） */

    cost: function (w, h, p) {
      var ch = (p.channels === 'luma') ? 1 : 3;
      var spec = (p.show === 'spectrum');
      return U.fftCost(w, h, ch, spec ? 1 : 2, spec ? 1 : 0);
    },

    prepare: function (src, p) {
      var G = Math.round(Math.sqrt(p.mask.length));
      var W = U.nextPow2(src.width), H = U.nextPow2(src.height);
      var i, x, y;

      /* 0..255 を 0..1 へ。反転はここで済ませる */
      var m = new Float32Array(G * G);
      for (i = 0; i < G * G; i++) m[i] = (p.invert ? (255 - p.mask[i]) : p.mask[i]) / 255;

      /* 縁のぼかし。箱ぼかしを2回かけて三角形の重みにする。
       *
       * 巻き戻し（円環）で回すのが要点。周波数の格子は端でつながっているうえ、
       * 端で打ち切るとマスクの点対称が崩れ、逆変換の結果に虚部が残ってしまう。 */
      var r = Math.round(p.soft);
      if (r > 0) {
        var pass = function (a) {
          var t = new Float32Array(G * G), o = new Float32Array(G * G);
          var xx, yy, k, s, n = 2 * r + 1;
          for (yy = 0; yy < G; yy++) {
            for (xx = 0; xx < G; xx++) {
              s = 0;
              for (k = -r; k <= r; k++) s += a[yy * G + ((((xx + k) % G) + G) % G)];
              t[yy * G + xx] = s / n;
            }
          }
          for (yy = 0; yy < G; yy++) {
            for (xx = 0; xx < G; xx++) {
              s = 0;
              for (k = -r; k <= r; k++) s += t[((((yy + k) % G) + G) % G) * G + xx];
              o[yy * G + xx] = s / n;
            }
          }
          return o;
        };
        m = pass(pass(m));
      }

      /* 格子 → ビン。DC を中心に対称に丸める（U.fftGridIndex がその役目） */
      var gxs = new Int32Array(W), gys = new Int32Array(H);
      for (i = 0; i < W; i++) gxs[i] = U.fftGridIndex((i + (W >> 1)) % W, W, G);
      for (i = 0; i < H; i++) gys[i] = U.fftGridIndex((i + (H >> 1)) % H, H, G);

      var gain = new Float32Array(W * H);
      for (y = 0; y < H; y++) {
        var gy = gys[y] * G, row = y * W;
        for (x = 0; x < W; x++) gain[row + x] = m[gy + gxs[x]];
      }

      var ctx = U.fftAnalyze(src, p.channels === 'luma', p.edge);
      U.fftApplyGain(ctx, gain);
      return { out: (p.show === 'spectrum')
        ? U.fftSpectrumImage(ctx, 3, gain)
        : U.fftToImage(ctx) };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: '周波数フィルタの通過率を、式で決める代わりに手で描きます。右のスペクトルを筆でなぞると、その周波数成分が落ちます。落とした状態で逆変換すれば、その成分だけが抜けた画像が戻ってきます。\n\nたとえるなら、録音した音を波形ではなくスペクトログラムの上で編集する作業です。「この帯域のこの音だけ消す」を、耳ではなく目で狙って行います。画像でも同じことができる、というのがこの処理の主張です。\n\n筆は必ず点対称の位置にも同時に乗ります。実数の画像のスペクトルは F(−u, −v) = conj(F(u, v)) を満たしていて、片側だけ消すとこの対称が崩れ、逆変換の結果に虚部が残って絵が壊れるためです。',
      formula: 'G(u, v) = F(u, v) · M(u, v)、  g = IFFT(G)\nM は手描きのマスク（0 = 遮る 〜 1 = 通す）\nマスクは正規化周波数 −0.5〜0.5 を 128 等分した格子で持ち、\n対称条件 M(−u, −v) = M(u, v) を塗るときに強制している',
      notes: [
        '**まず「周期ノイズ（斜め縞）」サンプルで試してください。**スペクトルの中心から離れた場所に、孤立した輝点が1組あります。そこを塗ると縞だけが消え、下にあった絵が出てきます。空間フィルタでは絵をなまらせずに縞を取ることはできません。周波数領域を扱う理由が、この1回で伝わります。',
        '次に「幾何図形」サンプルで、中心から放射状に伸びる輝線を1本だけ塗ってみてください。その向きのエッジだけが消えます。「向き」という情報がスペクトルのどこに入っているかが体で分かります。',
        '中心（DC）を塗ると平均の明るさが失われ、画像全体が中間調に沈みます。逆に中心だけを残すとのっぺりした濃淡だけになります。中心付近が「大まかな明暗」、外側が「細かい模様」だという対応を確かめるのに使えます。',
        '「マスクの縁のぼかし」を 0 にすると、崖のように切ることになるので輪郭に波紋（リンギング）が出ます。2〜4 に上げると消えます。周波数フィルタの「理想 vs ガウシアン」とまったく同じ話が、手描きでも起きます。',
        '「反転」を入れると、塗ったところ**だけ**を通します。輝点を1組塗ってから反転すると、その縞だけを取り出した画像が見られます。ノイズを消すのと、ノイズを抽出するのは、マスクの裏表の関係にあります。',
        'プリセットのボタンで、ローパス・ハイパス・バンドパス・十字（縦横の成分を落とす）をすぐ作れます。そこから筆で足し引きするのが手早い使い方です。「十字」は、境界処理をゼロ詰めにしたときに出る十字を消すのに使えます。',
        'マスクは 128×128 の固定格子で持っているので、作業解像度を 640 から 1024 に上げても塗り直しは要りません。画像を差し替えても残ります。',
        'ビューアの「出すもの」を「マスクを掛けたあとのスペクトル」にすると、中央の大きな画面でスペクトルを確認できます。遮った場所には赤みが乗ります。画面共有では、大きいほうで位置を指しながら右で塗る、という使い方になります。',
        '塗るたびに順変換・逆変換をやり直しています（640×480・RGB で約 0.33 秒）。筆を止めた 0.09 秒後にまとめて計算し、途中の値は捨てているので、ドラッグ中に計算が積み上がることはありません。'
      ]
    }
  });
})();
