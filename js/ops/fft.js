/* ImageLab — ops/fft.js : FFT スペクトル（表示専用）
 *
 * 画像を周波数領域へ移して、そのようすを見せるだけの処理。
 * 加工するのは ops/fftfilter.js（式で決めるフィルタ）と
 * ops/fftmask.js（手で塗るマスク）のほう。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'fft',
    category: 'freq',
    label: 'FFT スペクトル',
    params: [
      { key: 'show', type: 'select', label: '表示', value: 'power',
        options: [{ value: 'power', label: '対数パワースペクトル' },
                  { value: 'phase', label: '位相（色相＝角度／明るさ＝強さ）' },
                  { value: 'magonly', label: '振幅だけで再構成（位相を捨てる）' },
                  { value: 'phaseonly', label: '位相だけで再構成（振幅を一定に）' }] },
      { key: 'gain', type: 'range', label: '対数の効き', min: 0, max: 6, step: 0.1, value: 3,
        when: function (p) { return p.show === 'power' || p.show === 'phase'; },
        format: function (v) { return '×10^' + v.toFixed(1); } },
      { key: 'edge', type: 'select', label: '境界処理（2の冪への埋め方）', value: 'reflect',
        options: [{ value: 'reflect', label: '鏡映で埋める（既定）' },
                  { value: 'zero', label: 'ゼロで埋める（十字が出ます）' },
                  { value: 'hann', label: 'Hann 窓を掛ける（十字が消えます）' }] },
      { key: 'axes', type: 'checkbox', label: '周波数の目盛りを重ねる', value: true,
        when: function (p) { return p.show === 'power' || p.show === 'phase'; } }
    ],

    /* FFT は画像全体を一度に扱うので行帯に分けられない。
       halo を画像の高さより大きくしておくと、worker.js は帯を1本にまとめ、
       1つのワーカーへ丸ごと渡す（分担はしないが、計算中も画面は固まらない）。 */
    halo: function () { return 1e9; },

    cost: function (w, h, p) {
      /* 表示だけなら順変換の1回。再構成は逆変換のぶんもう1回 */
      var spec = (p.show === 'power' || p.show === 'phase');
      return U.fftCost(w, h, 1, spec ? 1 : 2, spec ? 1 : 0);
    },

    /* 周波数領域の処理は prepare で最後まで作りきる（kernel は切って渡すだけ）。
       スペクトルは輝度1枚で見る。RGB それぞれのスペクトルを重ねても読めないため。 */
    prepare: function (src, p) {
      var ctx = U.fftAnalyze(src, true, p.edge);
      var img;

      if (p.show === 'power') {
        img = U.fftSpectrumImage(ctx, p.gain, null);
        if (p.axes) U.fftAxesOverlay(img);
      } else if (p.show === 'phase') {
        img = U.fftPhaseImage(ctx, p.gain);
        if (p.axes) U.fftAxesOverlay(img);
      } else {
        var W = ctx.W, H = ctx.H, n = W * H;
        var re = ctx.re[0], im = ctx.im[0], i, m;
        if (p.show === 'magonly') {
          /* 位相を全部 0 にする。振幅（＝どの細かさの成分がどれだけあるか）だけが残る */
          for (i = 0; i < n; i++) {
            re[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
            im[i] = 0;
          }
        } else {
          /* 振幅を全部 1 にする。位相（＝その成分がどこにあるか）だけが残る */
          for (i = 0; i < n; i++) {
            m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
            if (m > 1e-12) { re[i] = re[i] / m; im[i] = im[i] / m; }
            else { re[i] = 0; im[i] = 0; }
          }
        }
        U.fft2d(re, im, W, H, ctx.planW, ctx.planH, true);
        /* 振幅だけの再構成は原点に集まるので、中央へ巻き直してから切り出す */
        img = U.fftPlaneToImage(re, W, H, src.width, src.height, p.show === 'magonly');
      }
      return { out: img };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: '画像を「いろいろな細かさの縞模様の重ね合わせ」として書き直したものが、2次元フーリエ変換です。出てくるスペクトルは、中央が DC（画像全体の明るさ）、中央から離れるほど細かい縞に対応します。輝点の位置がその縞の向きと細かさを、明るさがその縞がどれだけ含まれているかを表します。\n\nたとえるなら、音を「ドレミの成分がそれぞれどれだけ入っているか」に分解する作業の、2次元版です。楽譜のどの音がどれだけ鳴っているかを見るのと同じ要領で、画像のどの細かさの模様がどれだけ入っているかを見ます。\n\n実装は Cooley-Tukey の FFT を自前で書いています。素朴に定義どおり計算すると 640×480 で 10¹¹ 回の掛け算になり現実的でないところを、「偶数番目と奇数番目に分けて再利用する」ことで N log N まで落としています。2次元は「行ごとに1次元 → 列ごとに1次元」に分けられる（分離可能）ので、1次元の FFT がひとつあれば足ります。',
      formula: 'F(u, v) = Σ_x Σ_y f(x, y) · exp( −2πi (ux/W + vy/H) )\nf(x, y) = (1/WH) Σ_u Σ_v F(u, v) · exp( +2πi (ux/W + vy/H) )\n表示しているのは log(1 + a·|F| / max|F|) / log(1 + a)　（a = 10^対数の効き）\n計算量：定義どおりなら O(N²)、FFT なら O(N log N)',
      notes: [
        '「ゾーンプレート」サンプルを開いてみてください。中心から外へ向かって縞が細かくなる画像なので、スペクトルはドーナツ状のリングになります。画像の見た目とスペクトルの対応が一番わかりやすい題材です。',
        '「幾何図形」サンプルでは、直線に対して直角の向きに輝線が伸びます。エッジは「その向きに垂直な縞の集まり」だからです。斜線の束が別の角度の輝線を作るのも見えます。',
        '「周期ノイズ（斜め縞）」サンプルでは、中心から離れた場所に**孤立した輝点が1組**出ます。これが縞の正体です。ここを潰せば縞だけが消えます（スペクトルマスク／周波数フィルタのノッチ）。同好会で一番効く流れは、この点を見せてから消しに行く順番です。',
        '「境界処理」を「ゼロで埋める」に切り替えると、スペクトルに強い十字が現れます。FFT は画像が上下左右に無限に繰り返していると仮定するので、右端と左端の食い違いが「縦に走る段差」として扱われ、その成分が十字になって出ます。画像そのものには無い模様です。「Hann 窓」にすると縁が滑らかに落ちるので十字は消えます。既定の「鏡映」はその中間です。',
        '「振幅だけで再構成」と「位相だけで再構成」を見比べてください。振幅だけだと何が写っていたか分かりませんが、位相だけにすると輪郭がはっきり読み取れます。画像の構造は主に位相のほうに入っている、という有名な事実がそのまま見えます。振幅は「どんな細かさの縞がどれだけあるか」しか言っておらず、「それがどこにあるか」は位相が持っているためです。',
        '対数で圧縮して表示しています。DC の成分は他より 10⁵ 倍以上大きいことが普通で、線形のまま描くと中央の1点以外は真っ黒になります。「対数の効き」を 0 に近づけると、その真っ黒な状態が見られます。',
        'radix-2 の FFT は長さが2の冪でないと回らないので、640×480 の画像は 1024×512 の格子に広げてから変換しています。表示しているのはその 1024×512 のスペクトルを画面の大きさに縮めたものです。左端が −ナイキスト周波数（0.5 サイクル/画素＝2画素で1周期）、中央が 0、右端が +ナイキスト手前にあたります。重ねてある円は 0.125 / 0.25 / 0.375 サイクル/画素の目盛りです。'
      ]
    }
  });
})();
