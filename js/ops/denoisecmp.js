/* ImageLab — ops/denoisecmp.js : ノイズ除去の比較（メディアン／バイラテラル／ガウシアン）
 *
 * 原画にノイズを乗せ、3手法で消して、原画との PSNR / SSIM を並べる。
 *
 * ■ ビューアが「1画面1処理」なので、見せ方を2つ用意した
 *   ・ふだん  … 「表示」で1手法を選ぶ。全解像度のまま、分割スライダーで原画と比べられる
 *   ・実演    … 「表示」を〈4分割で並べる〉にすると、1枚の中に4面を貼り合わせて返す
 *                （各面は半分の解像度。見出しと数値はビューアに重ねて描く）
 * どちらの表示でも、右下には3手法ぶんの数値がそろって出る。
 *
 * ■ 除去の中身は既存の処理をそのまま呼んでいる
 *   U.opKernel('median') のように呼ぶので、アルゴリズムの二重管理は起きない。
 *   IL.opById を直接引くと Worker の中で壊れる（IL が無い）ので使わないこと。
 *
 * ■ この処理は行帯に分けられない
 *   PSNR / SSIM が画像全体の集計なので、帯ごとには出せない。FFT と同じく
 *   halo に大きい値を返して、丸ごと1つのワーカーへ渡している。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'denoisecmp',
    category: 'noise',
    label: 'ノイズ除去の比較',

    params: [
      { key: 'view', type: 'select', label: '表示', value: 'tile',
        options: [{ value: 'tile', label: '4分割で並べる（実演向け）' },
                  { value: 'noisy', label: 'ノイズあり（全解像度）' },
                  { value: 'median', label: 'メディアン（全解像度）' },
                  { value: 'bilateral', label: 'バイラテラル（全解像度）' },
                  { value: 'gauss', label: 'ガウシアン（全解像度）' }] },

      { key: 'kind', type: 'select', label: 'ノイズの種類', value: 'gauss',
        options: [{ value: 'gauss', label: 'ガウシアン（読み出しノイズ）' },
                  { value: 'sp', label: 'ソルト＆ペッパー（欠陥・伝送エラー）' },
                  { value: 'shot', label: 'ショット（光子数のゆらぎ）' }] },
      { key: 'sigma', type: 'range', label: 'ノイズの σ', min: 1, max: 60, step: 1, value: 20,
        when: function (p) { return p.kind === 'gauss'; },
        format: function (v) { return v + ' 階調'; } },
      { key: 'prob', type: 'range', label: '飛ぶ画素の割合', min: 0.005, max: 0.3, step: 0.005, value: 0.05,
        when: function (p) { return p.kind === 'sp'; },
        format: function (v) { return (v * 100).toFixed(1) + ' %'; } },
      { key: 'peak', type: 'range', label: '最大光子数', min: 3, max: 300, step: 1, value: 30,
        when: function (p) { return p.kind === 'shot'; },
        format: function (v) { return v + ' 個（少ないほど粗い）'; } },
      { key: 'color', type: 'checkbox', label: 'ノイズを色ごとに独立に乗せる', value: false },
      { key: 'seed', type: 'range', label: '乱数の種', min: 1, max: 20, step: 1, value: 1,
        format: function (v) { return '#' + v; } },

      { key: 'mradius', type: 'range', label: 'メディアンの窓の半径', min: 1, max: 4, step: 1, value: 1,
        format: function (v) { return v + ' px（窓は ' + (2 * v + 1) + ' × ' + (2 * v + 1) + '）'; } },
      { key: 'bsigmaS', type: 'range', label: 'バイラテラルの σ_space', min: 0.5, max: 5, step: 0.1, value: 2.0,
        format: function (v) { return v.toFixed(1) + ' px'; } },
      { key: 'bsigmaC', type: 'range', label: 'バイラテラルの σ_color', min: 2, max: 100, step: 1, value: 40,
        format: function (v) { return v + ' 階調'; } },
      { key: 'gsigma', type: 'range', label: 'ガウシアンの σ', min: 0.3, max: 6, step: 0.1, value: 1.5,
        format: function (v) { return v.toFixed(1) + ' px'; } }
    ],

    /* 全体を1つのワーカーへ（帯には分けられない。頭のコメントを参照） */
    halo: function () { return 1e9; },

    cost: function (w, h, p) {
      var mwin = 2 * p.mradius + 1;
      var bwin = 2 * Math.min(10, Math.ceil(p.bsigmaS * 2)) + 1;
      var gkl = U.gaussianKernel1d(p.gsigma).length;
      var noise = w * h * ((p.kind === 'shot') ? 2.5e-4 : 6.0e-5);
      var median = w * h * mwin * mwin * 3 * 1.48e-5;
      var bilat = w * h * bwin * bwin * 1.16e-5;
      var gauss = w * h * 2 * gkl * 3 * 2.0e-6;
      /* 数値（PSNR / SSIM）は4組ぶん。SSIM のガウシアン窓が効くので無視できない */
      var metrics = w * h * 4 * 2.3e-4;
      return noise + median + bilat + gauss + metrics;
    },

    prepare: function (src, p) {
      var w = src.width, h = src.height;

      /* --- 1. 汚す --- */
      var noisy = U.noiseBand(src, { kind: p.kind, sigma: p.sigma, prob: p.prob,
                                     peak: p.peak, seed: p.seed, color: p.color }, 0, h);

      /* --- 2. 3手法で消す。中身は既存の処理をそのまま呼ぶ --- */
      var mp = { radius: p.mradius, iter: 1 };
      var bp = { sigmaS: p.bsigmaS, sigmaC: p.bsigmaC, metric: 'luma' };
      var gp = { kind: 'gauss', sigma: p.gsigma };

      var med = U.opKernel('median')(noisy, mp, 0, h, U.opPrepare('median')(noisy, mp));
      var bil = U.opKernel('bilateral')(noisy, bp, 0, h, U.opPrepare('bilateral')(noisy, bp));
      var gau = U.opKernel('blur')(noisy, gp, 0, h, U.opPrepare('blur')(noisy, gp));

      /* --- 3. 原画と比べる。基準側の計算は1回で使い回す --- */
      var ref = U.ssimRef(src);
      var imgs = [noisy, med, bil, gau];
      var names = ['ノイズあり', 'メディアン', 'バイラテラル', 'ガウシアン'];
      var nums = [], i, ps, ss;

      for (i = 0; i < 4; i++) {
        ps = U.psnr(src, imgs[i]);
        ss = U.ssimAgainst(ref, imgs[i]);
        nums.push({ psnr: ps, ssim: ss, ptxt: isFinite(ps) ? ps.toFixed(1) : '∞' });
      }

      /* 除去の3つ（1〜3）の中の最良に印をつける。
         PSNR と SSIM は別々に見る。この2つはよく食い違い、
         どちらが勝つかが手法の性格をそのまま表すので、まとめてしまうと話が消える。 */
      var bp = 1, bs = 1;
      for (i = 2; i < 4; i++) {
        if (nums[i].psnr > nums[bp].psnr) bp = i;
        if (nums[i].ssim > nums[bs].ssim) bs = i;
      }

      var rows = [['PSNR / SSIM', '★ が各列の最良']];
      for (i = 0; i < 4; i++) {
        rows.push([names[i],
                   (i === bp ? '★' : '') + nums[i].ptxt + ' dB / ' +
                   (i === bs ? '★' : '') + nums[i].ssim.toFixed(3)]);
      }

      /* --- 4. 見せ方に合わせて1枚にまとめる --- */
      var out, tiles = null;
      if (p.view === 'tile') {
        out = U.tile2x2([U.halveImage(noisy), U.halveImage(med),
                         U.halveImage(bil), U.halveImage(gau)], w, h);
        var hw = w >> 1, hh = h >> 1;
        tiles = [];
        for (i = 0; i < 4; i++) {
          tiles.push({ x: (i % 2) * hw, y: (i >> 1) * hh, w: hw, h: hh,
                       label: names[i],
                       sub: (i === bp ? '★' : '') + nums[i].ptxt + ' dB / SSIM ' +
                            (i === bs ? '★' : '') + nums[i].ssim.toFixed(3),
                       best: (i === bp || i === bs) });
        }
      } else {
        out = { noisy: noisy, median: med, bilateral: bil, gauss: gau }[p.view] || noisy;
      }

      return { out: out, report: { rows: rows, tiles: tiles } };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: 'ノイズの種類によって、効く除去手法が変わります。それを同じ画像・同じノイズで並べて確かめるための処理です。原画にノイズを乗せ、メディアン・バイラテラル・ガウシアンの3手法で消し、原画との PSNR / SSIM を並べます。\n\n見どころは2つあります。1つめは「万能な手法は無い」こと。ソルト＆ペッパーにはメディアンが圧勝しますが、ガウシアンノイズでは最下位に落ちます。2つめは「物差しによって答えが変わる」こと。PSNR で選ぶ手法と SSIM で選ぶ手法は、しばしば別になります。\n\nたとえるなら、汚れの落とし方の比較です。泥はねなら1粒ずつ取り除く（メディアン）のが早く、全体のくすみなら面でならす（ガウシアン）ほうが早い。柄を消さずにくすみだけ取るには手間のかかるやり方（バイラテラル）が要る、という関係です。',
      formula: 'PSNR = 10 · log₁₀( 255² / MSE )　　MSE = 平均二乗誤差（RGB 3チャンネル）\nSSIM = 平均 [ (2μxμy + C₁)(2σxy + C₂) / ((μx² + μy²+ C₁)(σx² + σy² + C₂)) ]\n　　窓は 11×11・σ=1.5 のガウシアン、C₁ = (0.01·255)²、C₂ = (0.03·255)²',
      notes: [
        'まず「ノイズの種類」を〈ソルト＆ペッパー〉にしてください。メディアンが両方の物差しで圧勝し、PSNR は他の2つを 14 dB 以上引き離します。ここでのバイラテラルはほとんど効きません（ノイズあり 18.5 dB に対して 19.1 dB）。飛んだ画素の値が周りとかけ離れているせいで、バイラテラルがそれを「エッジ」と見なして守ってしまうためです。手法の性格が裏目に出る例として分かりやすいところです。',
        '次に〈ガウシアン〉に戻すと、メディアンは最下位に落ちます。ノイズの種類で順位が入れ替わる — 万能な手法は無い、というのがこの処理の主題です。',
        'PSNR と SSIM はよく食い違います。★は列ごとに付くので、2つの★が別の手法に付くことがあります。〈ジーメンススター〉がその例で、PSNR ではバイラテラル、SSIM ではガウシアンが勝ちます。PSNR は誤差の大きさしか見ないのに対し、SSIM は局所の平均・コントラスト・模様の並び方を見るためです。バイラテラルは平坦なところに残ったノイズを「エッジらしきもの」として守ってしまうので、誤差は小さいのに局所のばらつきが残り、SSIM で損をします。どちらに★が付くかは絵によって変わるので、サンプルを何枚か切り替えてみてください。',
        'ぼかしが必ず得になるとは限りません。〈幾何図形〉や〈ゾーンプレート〉のような細い線の多い絵では、ガウシアンの PSNR が「ノイズあり」を下回ります（幾何図形で 22.0 dB 対 23.6 dB）。σ=1.5 のぼかしが線とエッジを壊す損失のほうが、消したノイズの得より大きいためです。ところが同じ場面で SSIM は 0.850 と高く出ます。面積の大半を占める平坦な背景が滑らかになるからで、2つの物差しが正反対を指す一番はっきりした例です。',
        'ガウシアンの σ を上げていくと、PSNR はどこかで頭打ちになって下がりはじめますが、SSIM はそこからしばらく伸び続けます。「どこまでぼかすのが最適か」の答えが物差しによって違う、ということです。数値をひとつだけ見て決めてはいけない、という話にそのまま使えます。',
        '〈4分割で並べる〉は、1枚の画像の中に4面を貼り合わせて返しています。ビューアが「原画1枚 ⇄ 処理後1枚」の作りなので、並べるところまで処理の側でやってしまうほうが簡単だからです。そのぶん各面は縦横とも半分の解像度になります（4面とも同じ縮め方なので、比較の公平さは保たれます）。粒の立ち方まで見たいときは、表示を1手法に切り替えて全解像度で見るか、ルーペを当ててください。',
        '数値は必ず「原画」との比較です。ノイズを乗せる前の状態を持っているのは、この処理の中だけです。ふだんの画像処理で PSNR が測れないのは、正解にあたる原画が手元に無いからで、ここではノイズを自分で乗せることでその正解を用意しています。',
        'この処理は行帯に分けられないので、1つのワーカーに丸ごと渡しています。右下の「実行」欄に Worker 1 並列と出るのはそのためです。PSNR / SSIM が画像全体の集計で、帯ごとに出せないのが理由です。',
        'バイラテラルの σ_space は既定を 2.0 にしてあります（単体の処理では 3.0）。3手法ぶんを続けて計算するので、待ち時間を1秒以内に収めるためです。時間をかけてよければ上げてください。'
      ]
    }
  });
})();
