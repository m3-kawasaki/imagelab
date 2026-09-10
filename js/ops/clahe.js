/* ImageLab — ops/clahe.js : CLAHE（コントラスト制限付き適応的ヒストグラム平坦化） */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'clahe',
    category: 'point',
    label: 'CLAHE（適応的平坦化）',
    params: [
      { key: 'tiles', type: 'range', label: 'タイル分割数（縦横）', min: 2, max: 16, step: 1, value: 8,
        format: function (v) { return v + ' × ' + v; } },
      { key: 'clip', type: 'range', label: 'クリップ上限', min: 1, max: 10, step: 0.1, value: 2.5,
        format: function (v) { return v.toFixed(1) + '（平均度数の倍数）'; } },
      { key: 'amount', type: 'range', label: '強さ', min: 0, max: 1, step: 0.01, value: 1.0,
        format: function (v) { return Math.round(v * 100) + '%'; } }
    ],
    apply: function (src, p) {
      var w = src.width, h = src.height, s = src.data;
      var nx = p.tiles, ny = p.tiles;
      var tw = Math.ceil(w / nx), th = Math.ceil(h / ny);
      var maps = new Array(nx * ny);
      var i, k, x, y;

      /* 1. タイルごとにヒストグラムを取り、上限で刈り込んでから CDF を作る */
      for (var ty = 0; ty < ny; ty++) {
        for (var tx = 0; tx < nx; tx++) {
          var x0 = tx * tw, x1 = Math.min(w, x0 + tw);
          var y0 = ty * th, y1 = Math.min(h, y0 + th);
          var hist = new Uint32Array(256), count = 0;
          for (y = y0; y < y1; y++) {
            var row = y * w * 4;
            for (x = x0; x < x1; x++) {
              var j = row + x * 4;
              var v = U.RW * s[j] + U.GW * s[j + 1] + U.BW * s[j + 2];
              hist[v < 0 ? 0 : (v > 255 ? 255 : Math.round(v))]++;
              count++;
            }
          }
          /* クリップ：上限を超えたぶんを全ビンへ均等に配り直す。
             これをやらないと、平坦な領域のノイズが極端に増幅される */
          var limit = Math.max(1, p.clip * count / 256);
          var excess = 0;
          for (i = 0; i < 256; i++) if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
          var add = excess / 256;
          for (i = 0; i < 256; i++) hist[i] += add;

          var map = new Float32Array(256), acc = 0;
          var denom = Math.max(1, count);
          for (i = 0; i < 256; i++) { acc += hist[i]; map[i] = acc / denom * 255; }
          maps[ty * nx + tx] = map;
        }
      }

      /* 2. 画素ごとに、近い4タイルの写像を双線形で混ぜる。
         タイル境界に継ぎ目（ブロック状のムラ）が出るのを防ぐため */
      var out = new ImageData(w, h), d = out.data;
      for (y = 0; y < h; y++) {
        var gy = y / th - 0.5;
        var j0 = Math.floor(gy); var fy = gy - j0;
        var jA = U.clamp(j0, 0, ny - 1), jB = U.clamp(j0 + 1, 0, ny - 1);
        for (x = 0; x < w; x++) {
          var gx = x / tw - 0.5;
          var i0 = Math.floor(gx); var fx = gx - i0;
          var iA = U.clamp(i0, 0, nx - 1), iB = U.clamp(i0 + 1, 0, nx - 1);

          var o = (y * w + x) * 4;
          var r = s[o], g = s[o + 1], b = s[o + 2];
          var yy = U.RW * r + U.GW * g + U.BW * b;
          var vi = yy < 0 ? 0 : (yy > 255 ? 255 : Math.round(yy));

          var mAA = maps[jA * nx + iA][vi], mBA = maps[jA * nx + iB][vi];
          var mAB = maps[jB * nx + iA][vi], mBB = maps[jB * nx + iB][vi];
          var top = mAA + (mBA - mAA) * fx;
          var bot = mAB + (mBB - mAB) * fx;
          var ny2 = top + (bot - top) * fy;

          ny2 = yy + (ny2 - yy) * p.amount;

          if (yy < 1) {
            var delta = ny2 - yy;
            d[o] = U.clamp8(r + delta); d[o + 1] = U.clamp8(g + delta); d[o + 2] = U.clamp8(b + delta);
          } else {
            var ratio = ny2 / yy;
            d[o] = U.clamp8(r * ratio); d[o + 1] = U.clamp8(g * ratio); d[o + 2] = U.clamp8(b * ratio);
          }
          d[o + 3] = 255;
        }
      }
      return out;
    },
    doc: {
      principle: '画像をタイルに切り、タイルごとにヒストグラム平坦化をかけます。ただし度数に上限（クリップ）を設け、あふれたぶんを全階調に配り直してから累積を取ります。これで「平坦な部分のノイズだけが極端に持ち上がる」という適応的平坦化の副作用を抑えます。タイルの継ぎ目は、近い4タイルの写像を双線形で混ぜて消します。\n\nたとえるなら、全国一律のテストの偏差値ではなく、クラスごとに評価をつけ直すやり方です。ただし1人だけ突出しても評価が振り切れないよう上限を設け、クラスの境目では隣のクラスの基準と混ぜてなだらかにつなぎます。',
      formula: 'タイル (i, j) の写像 M_ij(v) = 255 · CDF_clip( v )\ng(x, y) = 双線形補間( M_i0j0, M_i1j0, M_i0j1, M_i1j1 )( f(x, y) )\nクリップ上限 = clip × （タイル画素数 / 256）',
      notes: [
        '「低コントラスト（暗部にディテール）」サンプルで、ヒストグラム平坦化と交互に切り替えてみてください。大域的な平坦化では右上の明るい窓が飛びますが、CLAHE では暗部のディテールを出しながら窓が残ります。ここが同好会での見せどころです。',
        'クリップ上限を上げるほど普通の適応的平坦化に近づき、ノイズが目立ちます。下げるほど恒等写像に近づいて効果が薄くなります。2〜3 あたりが実用域です。',
        'タイル数を増やすと局所性が強まりますが、増やしすぎると1タイルあたりの画素が減ってヒストグラムが荒れ、不自然なムラが出ます。',
        '医用画像や工業検査で「暗部を見たい」ときの定番です。ただし局所ごとに違う写像をかけるので、画素値の絶対量に意味がある測定用途にはそのまま使えません。'
      ]
    }
  });
})();
