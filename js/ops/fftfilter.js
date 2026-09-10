/* ImageLab — ops/fftfilter.js : 周波数フィルタ（ローパス／ハイパス／バンド／ノッチ）
 *
 * スペクトルに「通過率の分布」を掛けてから逆変換する。
 * 分布を式で決めるのがこのファイル、手で塗るのが ops/fftmask.js。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'fftfilter',
    category: 'freq',
    label: '周波数フィルタ',
    params: [
      { key: 'kind', type: 'select', label: '種類', value: 'lowpass',
        options: [{ value: 'lowpass', label: 'ローパス（細かい成分を落とす＝ぼかす）' },
                  { value: 'highpass', label: 'ハイパス（大きな明暗を落とす＝輪郭だけ）' },
                  { value: 'bandpass', label: 'バンドパス（ある細かさだけ通す）' },
                  { value: 'bandstop', label: 'バンドストップ（ある細かさだけ落とす）' },
                  { value: 'notch', label: 'ノッチ（特定の1点を潰す＝周期ノイズ除去）' }] },
      { key: 'shape', type: 'select', label: '切り方', value: 'gauss',
        options: [{ value: 'ideal', label: '理想（崖のように切る）' },
                  { value: 'gauss', label: 'ガウシアン（なだらかに切る）' },
                  { value: 'butter', label: 'バターワース（切れ味を次数で選ぶ）' }] },
      { key: 'order', type: 'range', label: 'バターワースの次数', min: 1, max: 10, step: 1, value: 2,
        when: function (p) { return p.shape === 'butter'; },
        format: function (v) { return 'n = ' + v; } },

      { key: 'cut', type: 'range', label: 'しきい周波数', min: 0.005, max: 0.5, step: 0.005, value: 0.06,
        when: function (p) { return p.kind !== 'notch'; },
        format: function (v) { return v.toFixed(3) + ' サイクル/画素（周期 ' + (1 / v).toFixed(1) + ' px）'; } },
      { key: 'width', type: 'range', label: '帯の幅', min: 0.005, max: 0.4, step: 0.005, value: 0.05,
        when: function (p) { return p.kind === 'bandpass' || p.kind === 'bandstop'; },
        format: function (v) { return '±' + (v / 2).toFixed(3); } },

      { key: 'nu', type: 'range', label: 'ノッチの位置 u（横）', min: -0.5, max: 0.5, step: 0.002, value: 0.18,
        when: function (p) { return p.kind === 'notch'; },
        format: function (v) { return v.toFixed(3); } },
      { key: 'nv', type: 'range', label: 'ノッチの位置 v（縦）', min: -0.5, max: 0.5, step: 0.002, value: 0.09,
        when: function (p) { return p.kind === 'notch'; },
        format: function (v) { return v.toFixed(3); } },
      { key: 'nr', type: 'range', label: 'ノッチの半径', min: 0.005, max: 0.2, step: 0.005, value: 0.03,
        when: function (p) { return p.kind === 'notch'; },
        format: function (v) { return v.toFixed(3); } },

      { key: 'channels', type: 'select', label: '対象', value: 'rgb',
        options: [{ value: 'rgb', label: 'RGB 個別（色のまま処理）' },
                  { value: 'luma', label: '輝度のみ（3倍速い）' }] },
      { key: 'edge', type: 'select', label: '境界処理（2の冪への埋め方）', value: 'reflect',
        options: [{ value: 'reflect', label: '鏡映で埋める（既定）' },
                  { value: 'zero', label: 'ゼロで埋める' }] },
      { key: 'show', type: 'select', label: 'ビューアに出すもの', value: 'image',
        options: [{ value: 'image', label: '処理後の画像' },
                  { value: 'spectrum', label: 'フィルタを掛けたあとのスペクトル' }] }
    ],

    halo: function () { return 1e9; },   /* 帯に分けられない（ops/fft.js の注記を参照） */

    cost: function (w, h, p) {
      var ch = (p.channels === 'luma') ? 1 : 3;
      var spec = (p.show === 'spectrum');
      return U.fftCost(w, h, ch, spec ? 1 : 2, spec ? 1 : 0);
    },

    prepare: function (src, p) {
      var W = U.nextPow2(src.width), H = U.nextPow2(src.height);
      var x, y, i;

      /* --- 通過率の形。r は正規化周波数（サイクル/画素）、返すのは 0..1 ---
       *
       * 理想     … cut で崖のように切る。実装は一番素直だが、空間領域では
       *             sinc 関数との畳み込みになるので輪郭に波紋（リンギング）が出る
       * ガウシアン … 逆変換してもガウシアンのままなので、波紋がまったく出ない
       * バターワース … 次数 n で切れ味を選べる。n を上げると理想に近づく */
      function low(r, cut, shape, order) {
        if (!(cut > 0)) return 0;
        if (shape === 'ideal') return r <= cut ? 1 : 0;
        if (shape === 'gauss') return Math.exp(-(r * r) / (2 * cut * cut));
        return 1 / (1 + Math.pow(r / cut, 2 * order));
      }

      /* ビンごとの (u, v)。0..W-1 の後ろ半分は負の周波数にあたる */
      var us = new Float32Array(W), vs = new Float32Array(H);
      for (i = 0; i < W; i++) us[i] = (i <= (W >> 1)) ? i / W : (i - W) / W;
      for (i = 0; i < H; i++) vs[i] = (i <= (H >> 1)) ? i / H : (i - H) / H;

      var gain = new Float32Array(W * H);
      var kind = p.kind, shape = p.shape, order = p.order;
      var lo = p.cut - p.width / 2, hi = p.cut + p.width / 2;

      for (y = 0; y < H; y++) {
        var v = vs[y], row = y * W;
        for (x = 0; x < W; x++) {
          var u = us[x], g;
          if (kind === 'notch') {
            /* 実数画像のスペクトルは点対称なので、必ず対称の位置も一緒に潰す。
               片方だけ潰すと逆変換の結果に虚部が残り、絵が壊れる */
            var d1 = Math.sqrt((u - p.nu) * (u - p.nu) + (v - p.nv) * (v - p.nv));
            var d2 = Math.sqrt((u + p.nu) * (u + p.nu) + (v + p.nv) * (v + p.nv));
            g = 1 - low(d1, p.nr, shape, order) - low(d2, p.nr, shape, order);
            if (g < 0) g = 0;
          } else {
            var r = Math.sqrt(u * u + v * v);
            if (kind === 'lowpass') g = low(r, p.cut, shape, order);
            else if (kind === 'highpass') g = 1 - low(r, p.cut, shape, order);
            else {
              /* 帯は「上を通すローパス × 下を落とすハイパス」で作る。
                 3つの切り方のどれでも同じ書き方で済む */
              var band = low(r, hi, shape, order) * (lo > 0 ? (1 - low(r, lo, shape, order)) : 1);
              g = (kind === 'bandpass') ? band : 1 - band;
            }
          }
          gain[row + x] = g;
        }
      }

      var ctx = U.fftAnalyze(src, p.channels === 'luma', p.edge);
      U.fftApplyGain(ctx, gain);
      return { out: (p.show === 'spectrum')
        ? U.fftSpectrumImage(ctx, 3, gain)
        : U.fftToImage(ctx) };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: '空間領域での畳み込みは、周波数領域では「掛け算1回」になります（畳み込み定理）。そこで画像を FFT でスペクトルに直し、残したい成分に 1、消したい成分に 0 に近い値を掛けてから逆変換します。中心付近を残せばローパス（ぼかし）、外側を残せばハイパス（輪郭抽出）、輪状に残せばバンドパスです。\n\nたとえるなら、オーディオのイコライザです。低音つまみを下げるのがハイパス、高音つまみを下げるのがローパス。特定の周波数だけをピンポイントで削るのがノッチ（ハウリング対策と同じ考え方）で、画像では周期ノイズの除去に使います。',
      formula: 'G(u, v) = F(u, v) · H(u, v)、  g = IFFT(G)\nr = √(u² + v²)（正規化周波数、単位はサイクル/画素）\n\n理想ローパス　　： H = 1 (r ≤ D₀), 0 (r > D₀)\nガウシアン　　　： H = exp( −r² / 2D₀² )\nバターワース　　： H = 1 / (1 + (r/D₀)^(2n))\nハイパス　　　　： H_hp = 1 − H_lp\nバンドパス　　　： H = H_lp(D₀+w/2) · (1 − H_lp(D₀−w/2))\nノッチ　　　　　： H = 1 − D(‖(u,v)−(u₀,v₀)‖) − D(‖(u,v)+(u₀,v₀)‖)',
      notes: [
        'まず「切り方」を**理想**にして、しきい周波数を下げてみてください。輪郭のまわりに同心円状の波紋が出ます。これがリンギング（Gibbs 現象）です。周波数を崖のように切ることは、空間領域では裾を引く sinc 関数を畳み込むことと同じで、その裾が波紋になります。「ガウシアン」に切り替えると波紋が消えます。ガウシアンはフーリエ変換してもガウシアンのままで、裾を引かないためです。',
        'バターワースは次数で切れ味を選べます。n=1 でなだらか、n を上げると理想に近づいてリンギングも戻ってきます。「切れ味と副作用は引き換え」という、フィルタ設計でいつも出てくる関係がそのまま見えます。',
        'ガウシアンのローパスは、空間フィルタの「ガウシアンぼかし」と同じ処理です。σ_space と D₀ は反比例の関係（D₀ ≈ 1/(2πσ)）にあります。空間フィルタのガウシアンと結果を見比べると、まったく別の道を通って同じ場所に着くことが確認できます。',
        'ハイパスにすると平均の明るさ（DC 成分）まで落ちるので、結果は 0 のまわりに散らばり、クリップされて暗く潰れます。輪郭が見えていれば正常です。「差分」表示や、しきい周波数を小さくした状態から始めると読み取りやすくなります。',
        '**ノッチが本命の使いどころです。**「周期ノイズ（斜め縞）」サンプルに切り替え、まず「FFT スペクトル」で中心から離れた孤立した輝点を見つけてください。その位置を u, v に入れて半径を少し取ると、縞だけが消えて元の絵が戻ります。空間フィルタ（メディアンやガウシアン）では、絵をなまらせない限り縞は取れません。周波数領域でやる価値が一番はっきり出る例です。',
        'ノッチは必ず点対称の位置と一緒に潰しています。実数の画像のスペクトルは F(−u, −v) = conj(F(u, v)) という対称性を持っていて、片方だけ削るとこの対称が崩れ、逆変換の結果に虚部が残ってしまうためです。手で塗るマスク（スペクトルマスク）でも同じ理由で、筆は必ず反対側にも乗ります。',
        '「対象」を輝度のみにすると3倍速くなりますが、出力は白黒になります。RGB 個別はチャンネルごとに独立して変換するので、640×480 で順変換と逆変換あわせて約 0.33 秒かかります。ワーカーに逃がしてあるので待っている間も画面は動きます。',
        '640×480 の画像は 1024×512 の格子に広げてから変換しています（radix-2 の FFT は長さが2の冪でないと回らないため）。広げた部分は鏡映で埋め、逆変換のあとで元の大きさに切り戻しています。'
      ]
    }
  });
})();
