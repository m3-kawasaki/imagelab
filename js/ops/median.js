/* ImageLab — ops/median.js : メディアンフィルタ */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'median',
    category: 'spatial',
    label: 'メディアン',
    params: [
      { key: 'radius', type: 'range', label: '窓の半径', min: 1, max: 5, step: 1, value: 1,
        format: function (v) { return v + ' px（窓は ' + (2 * v + 1) + ' × ' + (2 * v + 1) + '）'; } },
      { key: 'iter', type: 'range', label: '反復回数', min: 1, max: 3, step: 1, value: 1,
        format: function (v) { return v + ' 回'; } }
    ],
    /* 反復は「前の段の結果を次の段に入れる」形なので、段に分けて扱う。
       こうしないと、帯の境目で前の反復の結果が食い違う */
    stages: function (p) { return p.iter; },

    halo: function (p) { return p.radius; },

    cost: function (w, h, p) {
      var win = 2 * p.radius + 1;
      return w * h * win * win * 3 * p.iter * 1.48e-5;
    },

    prepare: function (src, p) {
      return { pl: U.splitPlanes(src) };
    },

    /* 行帯 [y0, y1) だけを処理する。
       kernel は Worker の中でも動くので、補助関数は外に置かず内側に畳んである
       （外側の変数を参照すると文字列化したときに壊れる）。 */
    kernel: function (src, p, y0, y1, c) {
      var w = src.width, h = src.height, r = p.radius;

      /* 窓が小さいうちは挿入ソートが素直で速い（分岐が単純） */
      function insertionMedian(buf, n) {
        for (var i = 1; i < n; i++) {
          var v = buf[i], j = i - 1;
          while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
          buf[j + 1] = v;
        }
        return buf[n >> 1];
      }

      /* 窓が大きくなると挿入ソートの O(n²) が効いてくる。
         中央値だけ分かればよいので、全体を並べ替えずに k 番目だけ取り出す。
         ざっくり O(n) で済み、11×11（121画素）だと十数倍の差になる。 */
      function quickSelectMedian(a, n) {
        var k = n >> 1, lo = 0, hi = n - 1;
        while (lo < hi) {
          var pivot = a[(lo + hi) >> 1], i = lo, j = hi, t;
          while (i <= j) {
            while (a[i] < pivot) i++;
            while (a[j] > pivot) j--;
            if (i <= j) { t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
          }
          if (k <= j) hi = j;
          else if (k >= i) lo = i;
          else break;
        }
        return a[k];
      }

      var size = (2 * r + 1) * (2 * r + 1);
      var buf = new Float32Array(size);
      var pick = (size <= 25) ? insertionMedian : quickSelectMedian;
      var pl = c.pl, out = new ImageData(w, y1 - y0), d = out.data;
      var ch, plane, x, y, dx, dy, n, yy, o;

      for (ch = 0; ch < 3; ch++) {
        plane = pl[ch];
        for (y = y0; y < y1; y++) {
          var inRow = (y >= r && y < h - r);
          for (x = 0; x < w; x++) {
            n = 0;
            if (inRow && x >= r && x < w - r) {      /* 内側：鏡映が要らない */
              for (dy = -r; dy <= r; dy++) {
                yy = (y + dy) * w + x;
                for (dx = -r; dx <= r; dx++) buf[n++] = plane[yy + dx];
              }
            } else {
              for (dy = -r; dy <= r; dy++) {
                yy = U.mir(y + dy, h) * w;
                for (dx = -r; dx <= r; dx++) buf[n++] = plane[yy + U.mir(x + dx, w)];
              }
            }
            o = ((y - y0) * w + x) * 4;
            d[o + ch] = U.clamp8(pick(buf, n));
            d[o + 3] = 255;
          }
        }
      }
      return out;
    },
    doc: {
      principle: '窓の中の画素を値の順に並べ、真ん中の値を採用します。平均と違って「足し算をしない」のが要点で、窓の中に極端な値が混ざっても、それが順位の端にいる限り結果に影響しません。線形フィルタではないため、重ね合わせも分離もできません。\n\nたとえるなら、審査員の点数から最高点と最低点を捨てて中央の評価を採るやり方です。1人が0点をつけても、平均と違って結果はほとんど動きません。',
      formula: 'g(x, y) = median{ f(x+i, y+j) : |i| ≤ r, |j| ≤ r }\n計算量：窓 k×k で素朴に O(N·k² log k)。窓が大きいときはヒストグラムを使った O(N·k) 実装が定石',
      notes: [
        '「ソルト＆ペッパーノイズ」サンプルで、ガウシアンと交互に切り替えてください。ガウシアンは黒点を灰色の染みに変えるだけですが、メディアンは半径1でほぼ完全に消します。この差がメディアンの存在意義です。',
        '一方でガウシアンノイズ（全画素に薄く乗るノイズ）にはあまり強くありません。「ガウシアンノイズ＋段差」サンプルで試すと、平滑化としては平凡だと分かります。ノイズの種類で手法を選ぶ、という話に繋がります。',
        'エッジは保たれますが、角が丸くなり、細い線は消えます。窓の中で少数派になった時点で中央値から外れるためです。「ぼけた細線・格子」サンプルの細い棒が消える順番を見ると、窓サイズとの関係が分かります。',
        '反復回数を増やすと「もうこれ以上変化しない」状態（ルート信号）に収束します。2〜3回で止まるのが普通で、非線形フィルタ特有の面白い性質です。',
        '窓が大きいと重くなります。1スレッドでの実測（640×480）は、半径1 が約120 ms、半径3 が約670 ms、半径5 が約1.5秒。中央値を取り出す部分は、窓が25画素を超えたら全体を並べ替えずに済むクイックセレクトへ切り替えています。それでも半径3以上は待たされるので、そこから先は Web Worker に逃がして複数のコアで分担します。',
        '反復回数を上げると、Worker の分担も反復1回ぶんずつ区切って進みます。反復2回目は1回目の結果を全部必要とするので、途中で待ち合わせる必要があるためです。「逐次表示」をオンにしておくと、同じ画像が上から順に2度3度と塗り替わっていくのが見え、反復で収束していく様子がそのまま観察できます。'
      ]
    }
  });
})();
