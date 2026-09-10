/* ImageLab — ops/lensdist.js : レンズ歪み（樽型・糸巻き型）と、その補正
 *
 * ■ 中身は「半径だけを伸び縮みさせる」写像
 *   中心からの距離 r を r·(1 + k₁r² + k₂r⁴) に置き換えるだけ。向きは変えない。
 *   k₁ < 0 なら外側ほど内へ寄って樽型、k₁ > 0 なら外へ広がって糸巻き型になる。
 *
 * ■ 「歪ませる」と「補正する」で計算の向きが違う
 *   補正   … 出力（まっすぐな絵）の半径 rᵤ から、読むべき半径 rᵈ が式で直に出る
 *   歪ませる … 出力（歪んだ絵）の半径 rᵈ から rᵤ を求めるので、式を逆に解く必要がある
 *   後者は解析的に解けないので Newton 法で解き、rᵈ → rᵤ の表を先に作っておく。
 *   1画素ごとに反復すると重いが、表なら引くだけで済む。
 *
 * ■ この処理は行帯に分けられない
 *   出力画素が入力のどこを読むかが決まっていないので、halo に大きい値を返して
 *   丸ごと1つのワーカーへ渡している。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'lensdist',
    category: 'sensor',
    label: 'レンズ歪みと補正（樽型・糸巻き型）',

    params: [
      { key: 'kind', type: 'select', label: 'すること', value: 'apply',
        options: [{ value: 'apply', label: '歪ませる（レンズを通した絵を作る）' },
                  { value: 'correct', label: '補正する（歪んだ絵をまっすぐに）' },
                  { value: 'roundtrip', label: '歪ませてから補正する（誤差を見る）' }] },

      { key: 'k1', type: 'range', label: '歪み係数 k₁', min: -0.5, max: 0.5, step: 0.01, value: -0.25,
        format: function (v) {
          return v.toFixed(2) + (v < -0.005 ? '（樽型）' : (v > 0.005 ? '（糸巻き型）' : '（なし）'));
        } },
      { key: 'k2', type: 'range', label: '歪み係数 k₂', min: -0.2, max: 0.2, step: 0.01, value: 0,
        format: function (v) { return v.toFixed(2) + '（外周だけを効かせる項）'; } },
      { key: 'zoom', type: 'range', label: 'ズーム', min: 0.5, max: 1.5, step: 0.01, value: 1,
        format: function (v) { return v.toFixed(2) + ' 倍'; } },

      { key: 'grid', type: 'checkbox', label: '格子を重ねてから歪ませる', value: true },

      { key: 'interp', type: 'select', label: '補間', value: 'bilinear',
        options: [{ value: 'nearest', label: '最近傍（1点）' },
                  { value: 'bilinear', label: 'バイリニア（4点）' },
                  { value: 'bicubic', label: 'バイキュービック（16点）' }] },
      { key: 'edge', type: 'select', label: '外側の扱い', value: 'zero',
        options: [{ value: 'zero', label: '黒で埋める' },
                  { value: 'clamp', label: '端の画素を伸ばす' },
                  { value: 'mirror', label: '鏡映' }] }
    ],

    halo: function () { return 1e9; },

    /* アフィンと同じく、補間のタップ数が処理時間に出ることを見せるので
       経路をそろえる（js/worker.js の J.run） */
    route: 'worker',

    /* 処理時間を見せるので、1回空回ししてから2回まわして速いほうを採る。
       1回きりだと、ワーカーが温まっていない・PC が混んでいる、といった事情だけで
       数倍に振れる（js/worker.js の workerBody） */
    bench: 2,

    cost: function (w, h, p) {
      /* 係数は node docs/_bench.js の実測から。アフィンより出入りが重いのは、
         画素ごとに半径（sqrt）を出して表を引くぶん */
      var pass = w * h * (U.interpTaps(p.interp) * 1.08e-5 + 6.7e-5);
      var n = (p.kind === 'roundtrip') ? 2 : 1;
      var metrics = (p.kind === 'roundtrip') ? w * h * 1.5e-5 : 0;
      return pass * n + metrics;
    },

    prepare: function (src, p) {
      var w = src.width, h = src.height;
      var cx = (w - 1) / 2, cy = (h - 1) / 2;
      /* 半径は「中心から隅まで」を 1 に取る。画像の縦横比によらず
         同じ k₁ が同じ見え方になるので、係数の意味が分かりやすい */
      var R = Math.sqrt(cx * cx + cy * cy);
      var k1 = p.k1, k2 = p.k2;
      var i, j;

      /* まっすぐな半径 → 歪んだ半径（レンズが実際にやること） */
      function distort(ru) {
        var r2 = ru * ru;
        return ru * (1 + k1 * r2 + k2 * r2 * r2);
      }

      /* 歪んだ半径 → まっすぐな半径。上の式を Newton 法で解く。
         1画素ごとに反復すると重いので、表を作って引く */
      var TAB = 2048, RMAX = 2.0;
      var inv = new Float32Array(TAB + 1);
      for (i = 0; i <= TAB; i++) {
        var rd = i / TAB * RMAX;
        var ru = rd, step = 0;
        for (j = 0; j < 20; j++) {
          var r2 = ru * ru;
          var f = ru * (1 + k1 * r2 + k2 * r2 * r2) - rd;
          var df = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2;
          if (df < 1e-6) break;                 /* 写像が折り返した先は追わない */
          step = f / df;
          ru -= step;
          if (ru < 0) ru = 0;
          if (step < 1e-7 && step > -1e-7) break;
        }
        inv[i] = ru;
      }
      function undistort(rd) {
        var t = rd / RMAX * TAB;
        if (t <= 0) return 0;
        if (t >= TAB) return inv[TAB];
        var i0 = t | 0, fr = t - i0;
        return inv[i0] * (1 - fr) + inv[i0 + 1] * fr;
      }

      /* 格子を重ねる。歪みは「まっすぐな線がどう曲がるか」で見るのが一番早いので、
         元の絵に細い線を引いてから歪ませる */
      function withGrid(img) {
        var out = U.cloneImageData(img), d = out.data;
        var x, y, o, on;
        var pitch = Math.max(24, Math.round(Math.min(w, h) / 12));
        for (y = 0; y < h; y++) {
          for (x = 0; x < w; x++) {
            on = (x % pitch === 0) || (y % pitch === 0);
            if (!on) continue;
            o = (y * w + x) * 4;
            /* 下地が明るければ黒、暗ければ白。どちらでも線が見える */
            var v = (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) > 110 ? 0 : 255;
            d[o] = v; d[o + 1] = v; d[o + 2] = v;
          }
        }
        return out;
      }

      /* 1枚ぶんの逆写像。correct を true にすると補正の向きになる。
         prev は前の段の有効範囲（無ければ null）。往復のときは
         「2段とも画像の中を読めた画素」だけを有効として持ち回る */
      function warp(img, correct, prev) {
        var out = new ImageData(w, h), od = out.data;
        var px = new Float32Array(3);
        var valid = new Uint8Array(w * h);
        var x, y, o, nx, ny, r, rr, fac, sx, sy, outside = 0, maxShift = 0, inside, ix, iy;
        for (y = 0; y < h; y++) {
          for (x = 0; x < w; x++) {
            nx = (x - cx) / R / p.zoom;
            ny = (y - cy) / R / p.zoom;
            r = Math.sqrt(nx * nx + ny * ny);
            if (r < 1e-9) { fac = 1; }
            else {
              rr = correct ? distort(r) : undistort(r);
              fac = rr / r;
            }
            sx = cx + nx * fac * R;
            sy = cy + ny * fac * R;
            U.sampleImage(img, sx, sy, p.interp, p.edge, px);
            o = (y * w + x) * 4;
            od[o] = U.clamp8(px[0]); od[o + 1] = U.clamp8(px[1]); od[o + 2] = U.clamp8(px[2]);
            od[o + 3] = 255;
            var dsx = sx - x, dsy = sy - y, sh = Math.sqrt(dsx * dsx + dsy * dsy);
            if (sh > maxShift) maxShift = sh;

            inside = !(sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5);
            if (!inside) outside++;
            if (inside && prev) {
              ix = Math.round(sx); iy = Math.round(sy);
              if (ix < 0) ix = 0; else if (ix >= w) ix = w - 1;
              if (iy < 0) iy = 0; else if (iy >= h) iy = h - 1;
              inside = !!prev[iy * w + ix];
            }
            valid[y * w + x] = inside ? 1 : 0;
          }
        }
        return { img: out, outside: outside, maxShift: maxShift, valid: valid };
      }

      var base = p.grid ? withGrid(src) : src;
      var res, first, second = null;

      if (p.kind === 'correct') {
        first = warp(base, true, null);
        res = first.img;
      } else {
        first = warp(base, false, null);           /* 歪ませる */
        res = first.img;
        if (p.kind === 'roundtrip') {
          second = warp(res, true, first.valid);
          res = second.img;
        }
      }

      var kindName = { apply: '歪ませる', correct: '補正する', roundtrip: '歪ませてから補正' }[p.kind];
      var shape = k1 < -0.005 ? '樽型' : (k1 > 0.005 ? '糸巻き型' : '歪みなし');
      /* 隅（r = 1）がどれだけ動くか。係数の効き目を長さで言い直したもの */
      var cornerPx = Math.abs(distort(1) - 1) * R;

      var rows = [
        ['すること', kindName + '（' + shape + '）'],
        ['係数', 'k₁ = ' + k1.toFixed(2) + '　k₂ = ' + k2.toFixed(2)],
        ['隅の移動量', cornerPx.toFixed(1) + ' px（中心から隅まで ' + R.toFixed(0) + ' px）'],
        ['画像の外を読んだ画素', (first.outside * 100 / (w * h)).toFixed(1) + ' %'],
        ['補間', U.interpName(p.interp) + '：1画素あたり ' + U.interpTaps(p.interp) + ' 点を読む']
      ];

      if (p.kind === 'roundtrip') {
        /* 隅は歪ませた段で画面の外へ出てしまい、そもそも情報が無い。
           そこまで数えると「隅の黒さ」を測ることになるので、
           2段とも画像の中を読めた画素だけで比べる */
        var m = U.psnrMasked(base, res, second.valid);
        rows.push(['往復後の PSNR', (isFinite(m.psnr) ? m.psnr.toFixed(1) + ' dB' : '∞') +
                                    '（重なった範囲だけ）']);
        rows.push(['比べた範囲', (m.count * 100 / (w * h)).toFixed(1) + ' %']);
      }

      return { out: res, report: { rows: rows } };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: 'レンズは光を曲げる道具なので、まっすぐな線がまっすぐに写るとは限りません。広角レンズでは画面の縁が中心に寄って、四角い建物の輪郭が樽のようにふくらんで見えます（樽型歪み）。望遠側では逆に外へ引っ張られ、糸巻きのようにへこみます（糸巻き型歪み）。\n\nどちらも「中心からの距離だけが伸び縮みして、向きは変わらない」という形をしています。そこで中心からの距離 r を r·(1 + k₁r² + k₂r⁴) に置き換えるだけで、かなりよく表せます。奇数乗の項が無いのは、レンズが回転対称だからです。\n\n補正はこの逆をやります。ただし「まっすぐな絵から歪んだ絵を作る」のと「歪んだ絵をまっすぐにする」のとでは、式を解く向きが逆になります。前者は式を逆に解く必要があり、解析的には解けないので数値で解きます。\n\nたとえるなら、伸び縮みするゴムシートに絵を描く作業です。中心を押さえたまま外周を引っ張れば糸巻き型、外周を縮めれば樽型。補正は同じゴムを反対向きに引き戻すことにあたります。',
      formula: '歪みの式（中心からの距離だけを動かす）\n　rᵈ = rᵤ · (1 + k₁·rᵤ² + k₂·rᵤ⁴)\n　　rᵤ … まっすぐな絵での半径　rᵈ … 歪んだ絵での半径（どちらも隅を 1 に正規化）\n　k₁ < 0 で樽型、k₁ > 0 で糸巻き型\n\n補正（出力＝まっすぐ）：出力の rᵤ から上の式で rᵈ を出し、そこを読む ← 式で直に出る\n歪ませる（出力＝歪んだ絵）：出力の rᵈ から rᵤ を求める ← 上の式を Newton 法で解く\n\nNewton 法：rᵤ ← rᵤ − f(rᵤ) / f\'(rᵤ)　　f(rᵤ) = rᵤ(1 + k₁rᵤ² + k₂rᵤ⁴) − rᵈ\n　　　　　　　f\'(rᵤ) = 1 + 3k₁rᵤ² + 5k₂rᵤ⁴',
      notes: [
        'まず〈幾何図形〉で、〈格子を重ねてから歪ませる〉を入れたまま k₁ を −0.5 から +0.5 まで動かしてください。重ねた格子の線が、マイナス側では外へふくらみ（樽型）、プラス側では内へへこみます（糸巻き型）。歪みは「まっすぐな線がどう曲がるか」で見るのが一番早いので、格子を既定でオンにしてあります。',
        'k₂ は外周だけを効かせる項です。r⁴ に比例するので、中心付近ではほとんど効かず、隅で急に効きます。実際のレンズでは「中心寄りは樽型なのに隅で糸巻きに転じる」ことがあり（陣笠型）、k₁ と k₂ を逆符号にするとその形が作れます。k₁ = −0.3、k₂ = +0.2 あたりで格子を見ると、線が途中で曲がり方を変えるのが分かります。',
        '「すること」を〈歪ませる〉と〈補正する〉で切り替えると、同じ k₁ でも絵が逆向きに変わります。歪ませるほうは式を逆に解く必要があり、Newton 法で 2048 段の表を先に作ってから引いています。1画素ごとに反復すると 30 万回ぶんの反復になりますが、表なら作るのは 2048 回で済み、あとは引くだけです。「同じ計算を何度もするなら表にする」という定石そのものです。',
        '〈歪ませてから補正する〉を選ぶと、往復させた結果が出ます。理屈のうえでは原画に戻るはずですが、右下の PSNR は無限大になりません。しかも**歪みが強いほど戻りが悪くなります**（〈ジーメンススター〉・格子オフ・バイリニアで、k₁ = −0.1 が 33.5 dB、−0.25 で 32.2 dB、−0.4 で 28.9 dB）。樽型で内側に押し込まれた外周部は、そこで画素が間引かれてしまい、引き伸ばしても戻らないためです。**補正は「歪みを打ち消す」ことはできても「失われた解像度を取り戻す」ことはできません。**',
        '往復の数値は「歪ませた段と補正した段の両方で画像の中を読めた画素」だけで測っています。隅は歪ませた時点で画面の外へ出てしまい、そもそも情報が無いので、そこまで数えると補間の損ではなく隅の黒さを測ることになるからです。右下の「比べた範囲」がその割合です。**数字を読むときは〈格子を重ねる〉を外してください。**1画素幅の線は2回の再標本化で真っ先に壊れるので、格子を入れたままだと 20 dB 前後まで落ちます。',
        '往復の数値では、補間の順位が絵によって入れ替わります。〈ジーメンススター〉のような細かい絵ではバイキュービックが最良ですが、〈低コントラスト〉のようになだらかな絵では**最近傍が一番高く出ます**（k₁ = −0.25 で最近傍 44.0 dB 対 バイリニア 39.7 dB）。なだらかな絵では隣の画素との差が小さいので、最近傍のずれによる誤差より、バイリニアのぼかしによる誤差のほうが大きくなるためです。**「どの補間が良いか」は絵の細かさで決まる**、という話にそのまま使えます。',
        'k₁ をプラス（糸巻き型）にして往復させると、最近傍だけ PSNR が ∞ になります。糸巻き型を作る段では中心から外へ引き伸ばす＝拡大なので、最近傍だと元の画素がそのまま複製されるだけで、縮めて戻すときに複製の1つを選び直せば完全に元へ戻るためです。倍率がちょうど逆数の拡大→縮小は、最近傍に限って可逆になります。ただし「比べた範囲」は 78% まで落ちます（残りは画面の外へ出ています）。',
        '補正すると画面の四隅に黒い領域が出ます（樽型の場合）。歪んだ絵には、まっすぐな絵の隅にあたる場所が写っていないためです。実際のカメラやソフトはここでわずかに拡大して黒を追い出します。「ズーム」を 1.1 倍あたりに上げると同じことが起きるので、切り替えて見比べてください。画角が少し狭くなるのが代償です。',
        '「補間」を切り替えると、歪みの強い外周ほど差が出ます。最近傍では格子の線が階段状に割れ、バイリニアでは滑らかになります。中心付近はほとんど動かないので差が出ません。**変形の大きいところでだけ補間の質が効く**、というのがここで見えることです。右下の「計算時間」もタップ数に応じて上がりますが、この数字はベンチマークと同じ測り方（必ずワーカーで計算し、1回空回ししてから2回まわして速いほうを採る）で出しています。1回きりだと数倍に振れて比べられないためで、そのぶん「画面に出るまで」は3倍ほどになります。',
        'この処理は行帯に分けられません。出力画素が入力のどこを読むかが半径によって変わり、帯の外まで必要になりうるからです。丸ごと1つのワーカーへ渡しています。右下の「実行」欄に Worker 1 並列と出るのはそのためです。'
      ]
    }
  });
})();
