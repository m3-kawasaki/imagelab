/* ImageLab — ops/affine.js : アフィン変換（平行移動・回転・拡大縮小・せん断）
 *
 * ■ 逆写像で考える
 *   「入力の画素をどこへ飛ばすか」ではなく「出力の画素がどこを読むか」で回す。
 *   順方向に飛ばすと行き先が飛び飛びになって隙間が空くが、逆写像なら
 *   出力の全画素がちょうど1回ずつ埋まる。読む場所は小数になるので補間が要る。
 *
 * ■ 補間3種がそのまま速さと画質の階段になる
 *   最近傍（1点）… 速い。斜めの輪郭がギザギザに割れる
 *   バイリニア（4点）… ふつうはこれ。少しぼける
 *   バイキュービック（16点）… 輪郭が締まる。段差の脇にわずかな行き過ぎが出る
 *
 * ■ 往復させると補間の損が見える
 *   〈往復させて誤差を見る〉を入れると、変換したあとに逆変換で戻す。
 *   理屈のうえでは原画に戻るはずだが、補間を2回通るので戻らない。
 *   その戻らなさが PSNR の数字で出る。ただし画面の外へ出た隅は
 *   そもそも情報が無いので、2段とも中を読めた画素だけで測る（U.psnrMasked）。
 *
 * ■ この処理は行帯に分けられない
 *   出力画素が入力のどこを読むかが決まっていないので、帯の外まで必要になりうる。
 *   halo に大きい値を返して、丸ごと1つのワーカーへ渡している。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'affine',
    category: 'sensor',
    label: 'アフィン変換（回転・拡大・せん断）',

    params: [
      { key: 'rot', type: 'range', label: '回転角', min: -180, max: 180, step: 1, value: 20,
        format: function (v) { return v + ' °'; } },
      { key: 'zoom', type: 'range', label: '拡大率', min: 0.2, max: 3, step: 0.05, value: 1,
        format: function (v) { return v.toFixed(2) + ' 倍'; } },
      { key: 'shear', type: 'range', label: 'せん断（横方向）', min: -1, max: 1, step: 0.05, value: 0,
        format: function (v) { return v.toFixed(2); } },
      { key: 'tx', type: 'range', label: '平行移動 x', min: -50, max: 50, step: 1, value: 0,
        format: function (v) { return v + ' %（幅に対して）'; } },
      { key: 'ty', type: 'range', label: '平行移動 y', min: -50, max: 50, step: 1, value: 0,
        format: function (v) { return v + ' %（高さに対して）'; } },

      { key: 'interp', type: 'select', label: '補間', value: 'bilinear',
        options: [{ value: 'nearest', label: '最近傍（1点）' },
                  { value: 'bilinear', label: 'バイリニア（4点）' },
                  { value: 'bicubic', label: 'バイキュービック（16点）' }] },
      { key: 'edge', type: 'select', label: '外側の扱い', value: 'zero',
        options: [{ value: 'zero', label: '黒で埋める' },
                  { value: 'clamp', label: '端の画素を伸ばす' },
                  { value: 'mirror', label: '鏡映' }] },

      { key: 'roundtrip', type: 'checkbox', label: '往復させて誤差を見る（元に戻す）', value: false }
    ],

    /* 出力画素が入力のどこを読むか決まらないので、帯には分けない */
    halo: function () { return 1e9; },

    /* 補間3種のタップ数（1／4／16）が処理時間にそのまま出ることを見せる処理なので、
       軽くても必ずワーカーへ回して経路をそろえる（js/worker.js の J.run） */
    route: 'worker',

    /* 処理時間を見せるので、1回空回ししてから2回まわして速いほうを採る。
       1回きりだと、ワーカーが温まっていない・PC が混んでいる、といった事情だけで
       数倍に振れる（js/worker.js の workerBody） */
    bench: 2,

    cost: function (w, h, p) {
      /* 係数は node docs/_bench.js の実測から。
         1画素あたり「タップ数 × 1.08e-5 ＋ 出入りの 3.8e-5」ミリ秒。
         最近傍 15 ms／バイリニア 21 ms／バイキュービック 65 ms（640×480）がこの式で出る */
      var pass = w * h * (U.interpTaps(p.interp) * 1.08e-5 + 3.8e-5);
      var n = p.roundtrip ? 2 : 1;
      var metrics = p.roundtrip ? w * h * 1.5e-5 : 0;   /* 重なった範囲の PSNR だけ */
      return pass * n + metrics;
    },

    prepare: function (src, p) {
      var w = src.width, h = src.height;
      var cx = (w - 1) / 2, cy = (h - 1) / 2;
      var rad = p.rot * Math.PI / 180;
      var co = Math.cos(rad), si = Math.sin(rad);

      /* 順方向の行列 M（入力 → 出力）。中心まわりに
         「せん断 → 回転 → 拡大」の順にかける。
             M = zoom · R(θ) · Sh(shear)
         せん断を先にするのは、回したあとに横へ倒すより見た目が素直なため。 */
      var a = p.zoom * co, b = p.zoom * (co * p.shear - si);
      var c = p.zoom * si, d = p.zoom * (si * p.shear + co);
      var tx = p.tx / 100 * w, ty = p.ty / 100 * h;

      /* 逆行列。出力 → 入力を引くのに使う */
      var det = a * d - b * c;
      if (Math.abs(det) < 1e-12) det = 1e-12;      /* 拡大率0は UI で作れないが念のため */
      var ia = d / det, ib = -b / det, ic = -c / det, id = a / det;

      /* 1枚ぶんの逆写像。back を true にすると逆変換（往復の戻し）になる。
         prev は前の段の有効範囲（無ければ null）。往復のときは
         「1段目でも2段目でも画像の中を読めた画素」だけを有効として持ち回る */
      function warp(img, back, prev) {
        var out = new ImageData(w, h), od = out.data;
        var px = new Float32Array(3);
        var valid = new Uint8Array(w * h);
        var x, y, o, dx, dy, sx, sy, outside = 0, inside, ix, iy;
        for (y = 0; y < h; y++) {
          for (x = 0; x < w; x++) {
            if (!back) {
              /* 出力(x,y) が読む入力の位置 = M⁻¹ · (q − c − t) + c */
              dx = x - cx - tx; dy = y - cy - ty;
              sx = ia * dx + ib * dy + cx;
              sy = ic * dx + id * dy + cy;
            } else {
              /* 逆変換：出力(x,y) が読む位置 = M · (q − c) + c + t */
              dx = x - cx; dy = y - cy;
              sx = a * dx + b * dy + cx + tx;
              sy = c * dx + d * dy + cy + ty;
            }
            U.sampleImage(img, sx, sy, p.interp, p.edge, px);
            o = (y * w + x) * 4;
            od[o] = U.clamp8(px[0]); od[o + 1] = U.clamp8(px[1]); od[o + 2] = U.clamp8(px[2]);
            od[o + 3] = 255;

            inside = !(sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5);
            if (!inside) outside++;
            if (inside && prev) {
              /* 前の段でも中を読めていたか。読んだ位置に一番近い画素で見る */
              ix = Math.round(sx); iy = Math.round(sy);
              if (ix < 0) ix = 0; else if (ix >= w) ix = w - 1;
              if (iy < 0) iy = 0; else if (iy >= h) iy = h - 1;
              inside = !!prev[iy * w + ix];
            }
            valid[y * w + x] = inside ? 1 : 0;
          }
        }
        return { img: out, outside: outside, valid: valid };
      }

      var one = warp(src, false, null);
      var res = one.img;

      var rows = [
        ['変換行列', '[ ' + a.toFixed(3) + '  ' + b.toFixed(3) + ' ; ' +
                     c.toFixed(3) + '  ' + d.toFixed(3) + ' ]'],
        ['平行移動', tx.toFixed(1) + ' , ' + ty.toFixed(1) + ' px'],
        ['画像の外を読んだ画素', (one.outside * 100 / (w * h)).toFixed(1) + ' %'],
        ['補間', U.interpName(p.interp) + '：1画素あたり ' + U.interpTaps(p.interp) + ' 点を読む']
      ];

      if (p.roundtrip) {
        /* 戻したものと原画を比べる。理屈では一致するはずだが、
           補間を2回通るぶんだけ戻らない。そこが補間の損そのもの。
           ただし回転で画面の外へ出てしまった隅は、そもそも情報が無いので戻らない。
           そこまで数えると「隅の黒さ」を測ることになるので、
           2段とも画像の中を読めた画素だけで比べる */
        var two = warp(one.img, true, one.valid);
        res = two.img;
        var m = U.psnrMasked(src, res, two.valid);
        rows.push(['往復後の PSNR', (isFinite(m.psnr) ? m.psnr.toFixed(1) + ' dB' : '∞') +
                                    '（重なった範囲だけ）']);
        rows.push(['比べた範囲', (m.count * 100 / (w * h)).toFixed(1) + ' %']);
      }

      return { out: res, report: { rows: rows } };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: '画像を平行移動・回転・拡大縮小・せん断する処理です。この4つはまとめて2×3 の行列ひとつで書けて、どれだけ重ねがけしても行列の掛け算1回にまとまります。直線が直線のまま、平行な線が平行のまま保たれるのがアフィン変換の性質です。\n\n実装で肝心なのは「向き」です。入力の画素を行き先へ飛ばす（順写像）と、行き先が飛び飛びになって隙間が空いたり、2つが同じ場所へ落ちたりします。そこで逆向きに、出力の画素ごとに「これはもとの画像のどこを読めばよいか」を逆行列で求めます（逆写像）。こうすると出力の全画素がちょうど1回ずつ埋まります。\n\nただし読む場所は小数になります。1.7 行目の 3.2 列目に画素はありません。そこで周りの画素から作るのが補間です。\n\nたとえるなら、方眼紙に描いた絵を斜めの方眼紙に写す作業です。写す先のマスを1つずつ見て「元の絵ではこのあたり」と当たりを付けて色を決める。当たりの付け方が補間の種類にあたります。',
      formula: '順方向：[x\'] = [a b][x − cx] + [cx + tx]\n　　　　[y\']   [c d][y − cy]   [cy + ty]\n\n　[a b] = zoom · [cosθ −sinθ] · [1 sh]\n　[c d]          [sinθ  cosθ]   [0  1]\n\n逆写像（実際に回す向き）：もとの位置 = M⁻¹ · (出力の位置 − 中心 − 平行移動) + 中心\n\n補間の重み\n　最近傍　　　　： 一番近い1点\n　バイリニア　　： (1−fx)(1−fy), fx(1−fy), (1−fx)fy, fx·fy の4点\n　バイキュービック：Catmull-Rom（a = −0.5）の4×4 = 16点',
      notes: [
        'まず〈幾何図形〉で回転角を 20° あたりにして、「補間」を3つとも切り替えてください。最近傍では斜線と円の輪郭が階段状に割れます。バイリニアにすると滑らかになり、バイキュービックにすると輪郭がもう少し締まります。ルーペを当てると1画素単位で違いが見えます。',
        'バイキュービックの重みには負の部分があります（Catmull-Rom の a = −0.5）。そのため黒と白の段差の脇で、白側が少し行き過ぎ、黒側が少し沈みます。輪郭が締まって見えるのはこの行き過ぎのおかげでもあります。〈グレー階段＋ランプ〉の段差にルーペを当てると分かります。ぼけを嫌って締めれば、代わりに行き過ぎが出る、という交換条件です。',
        '〈往復させて誤差を見る〉を入れると、変換したあとに逆変換で元に戻します。理屈のうえでは原画に戻るはずですが、戻りません。補間を2回通るからです。〈ジーメンススター〉を 20° 回して往復させた実測で、最近傍 30.3 dB／バイリニア 31.2 dB／バイキュービック 34.8 dB。**最近傍が一番低いのは「ぼけない代わりに位置がずれる」ため**で、ずれは半画素まで出ます。画像編集で回転をやり直すたびに絵が甘くなるのは、この積み重ねです。\n\n数値は「行きと戻りの両方で画像の中を読めた画素」だけで測っています。回転で画面の外へ出た隅はそもそも情報が無いので、そこまで数えると補間の損ではなく隅の黒さを測ることになるからです。右下の「比べた範囲」がその割合で、20° なら 87.6% です。',
        '回転角を 90° や 180° にすると、往復の誤差が**完全に消えます**（PSNR が ∞ と出ます）。読む位置が画素の真上にぴたりと乗り、補間が1点だけを拾うので、どの補間を選んでも同じです。半端な角度でだけ損が出る、というのが補間の損の正体で、写真の 90° 回転が何度やっても劣化しないのもこれが理由です。',
        '「外側の扱い」は、回したときに空いた隅をどう埋めるかです。黒で埋めるのが素直ですが、そのあとさらにフィルタをかけるような場面では、黒との段差が偽のエッジになります。端の画素を伸ばす（clamp）か鏡映にしておくと、その段差が出ません。',
        '拡大率を 3 倍まで上げると、補間の違いが一番はっきり出ます。最近傍は画素が四角いまま大きくなり、バイリニアはぼけ、バイキュービックはその中間で輪郭が立ちます。逆に 0.2 倍まで縮めると、3つとも似たような結果になりますが、これは「縮めるときは本来ぼかしてから間引くべきなのに、していない」ためです（折り返しが出ます）。縮小には別の手当てが要る、という話につながります。',
        'この処理は行帯に分けられません。出力画素が入力のどこを読むかは変換しだいで、帯の外まで必要になりうるからです。FFT や比較と同じく、丸ごと1つのワーカーへ渡しています。右下の「実行」欄に Worker 1 並列と出るのはそのためです。',
        '補間を切り替えると右下の「計算時間」が 16 → 22 → 66 ms（640×480）と上がります。読む点の数（1 → 4 → 16）におおむね比例していて、「1画素あたり何点読むか」がそのまま時間になっていることが読めます。この「1画素あたりに読む点の数」をタップ数と呼び、右下の「補間」の行に出しています。この数字はベンチマークと同じ測り方で出しています（必ずワーカーで計算し、1回空回ししてから2回まわして速いほうを採る）。1回きりだと、ごみ集めやワーカーの温まり具合だけで数倍に振れてしまうためです。そのぶん「画面に出るまで」は3倍ほどになります。'
      ]
    }
  });
})();
