/* ImageLab — ops/threshold.js : 二値化（固定閾値／大津の判別分析法／適応的）
 *
 * ■ 3つの決め方を1つの処理にまとめてある
 *   ・固定    … 手でスライダーを動かす。基準になる形
 *   ・大津    … ヒストグラムから閾値を自動で決める
 *   ・適応的  … 画素ごとに、その周りの明るさから閾値を決める
 *   どれも「閾値を決めて、超えたら白」の一点だけが違う。並べて切り替えられるように
 *   まとめたほうが、手法の違いがそのまま見える。
 *
 * ■ 重い計算は全部 prepare に寄せてある
 *   大津の閾値も、適応的の「窓の平均」も、画像全体を見ないと出せない。
 *   prepare は Worker でも画像全体を受け取るので、ここで作ってしまえば
 *   kernel は「1画素を1つのしきい値と比べるだけ」になり、帯の境目で閾値が
 *   食い違う心配が消える。ただし prepare はワーカーごとに走るので、
 *   帯に分けても速くならない（halo の項を参照）。
 *
 * ■ 窓の平均は積分画像で出す
 *   素朴に窓の中を毎回足すと窓の面積に比例して重くなるが、積分画像を1枚作れば
 *   どんな窓でも足し引き4回で済む。窓の半径を動かしても処理時間が変わらないので、
 *   実演でスライダーを大きく振れる。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'threshold',
    category: 'binary',
    label: '二値化（固定／大津／適応的）',

    params: [
      { key: 'method', type: 'select', label: '閾値の決め方', value: 'otsu',
        options: [{ value: 'fixed', label: '固定（手で決める）' },
                  { value: 'otsu', label: '大津の判別分析法（自動）' },
                  { value: 'adaptive', label: '適応的（場所ごとに決める）' }] },

      { key: 'thr', type: 'range', label: '閾値', min: 0, max: 255, step: 1, value: 128,
        when: function (p) { return p.method === 'fixed'; },
        format: function (v) { return v + ' 階調'; } },

      { key: 'radius', type: 'range', label: '窓の半径', min: 3, max: 60, step: 1, value: 16,
        when: function (p) { return p.method === 'adaptive'; },
        format: function (v) { return v + ' px（窓は ' + (2 * v + 1) + ' × ' + (2 * v + 1) + '）'; } },
      { key: 'bias', type: 'range', label: '差の下駄 C', min: -30, max: 30, step: 1, value: 6,
        when: function (p) { return p.method === 'adaptive'; },
        format: function (v) { return v + ' 階調（大きいほど白が増える）'; } },
      { key: 'stat', type: 'select', label: '窓の測り方', value: 'mean',
        when: function (p) { return p.method === 'adaptive'; },
        options: [{ value: 'mean', label: '平均（積分画像・窓によらず一定時間）' },
                  { value: 'gauss', label: 'ガウシアン加重平均' }] },

      { key: 'invert', type: 'checkbox', label: '白黒を入れ替える', value: false }
    ],

    /* 帯に分けず、丸ごと1つのワーカーへ渡す。
     *
     * kernel は「1画素を1つの数と比べるだけ」なので、のりしろは本当は 0 でよく、
     * 何本に切っても結果は変わらない（セルフテストで押さえてある）。
     * ただし重い計算は全部 prepare にあり、prepare は各ワーカーで画像全体に対して
     * 走る。帯に分けると同じ計算を人数ぶん繰り返すだけで、速くならない。
     * FFT や比較 op と同じく、大きい値を返して1本にまとめている。 */
    halo: function () { return 1e9; },

    /* 「窓を広げても時間が変わらない（積分画像）／ガウシアン加重は重くなる」を
       数字で見せる処理なので、軽くても必ずワーカーへ回して経路をそろえる。
       メインスレッドで走らせると GC が挟まって数字が読めない（js/worker.js の J.run） */
    route: 'worker',

    /* 処理時間を見せるので、1回空回ししてから2回まわして速いほうを採る。
       1回きりだと、ワーカーが温まっていない・PC が混んでいる、といった事情だけで
       数倍に振れる（js/worker.js の workerBody） */
    bench: 2,

    cost: function (w, h, p) {
      /* グレー化＋ヒストグラム＋画素ごとの比較 */
      var base = w * h * 1.6e-5;
      if (p.method !== 'adaptive') return base;
      if (p.stat === 'gauss') {
        var kl = U.gaussianKernel1d(Math.max(0.6, p.radius / 2)).length;
        return base + w * h * 2 * kl * 2.0e-6;
      }
      /* 積分画像は窓の大きさによらず一定 */
      return base + w * h * 2.6e-5;
    },

    prepare: function (src, p) {
      var w = src.width, h = src.height, n = w * h;
      var g = U.toGrayPlane(src);
      var hist = U.histogram256(g);
      var i, x, y;

      /* --- 大津の判別分析法 ---
         「クラス間分散 σ²_b = ω₀ω₁(μ₀−μ₁)² が最大になる閾値」を全部試して選ぶ。
         累積和を持ち回れば 256 回のループで終わる。 */
      var total = n, sumAll = 0;
      for (i = 0; i < 256; i++) sumAll += i * hist[i];
      var wB = 0, sumB = 0, bestBetween = 0, otsu = 0;
      for (i = 0; i < 256; i++) {
        wB += hist[i];
        if (wB === 0) continue;
        var wF = total - wB;
        if (wF === 0) break;
        sumB += i * hist[i];
        var mB = sumB / wB, mF = (sumAll - sumB) / wF;
        var between = wB * wF * (mB - mF) * (mB - mF);   /* total² 倍した σ²_b */
        if (between > bestBetween) { bestBetween = between; otsu = i; }
      }

      /* 分離度 η = σ²_b / σ²_total。1 に近いほど「2つの山がきれいに分かれている」。
         固定閾値のときも、いま選んでいる閾値での η を出す（手で最大を探せる） */
      var mean = sumAll / total, varAll = 0;
      for (i = 0; i < 256; i++) varAll += hist[i] * (i - mean) * (i - mean);
      varAll /= total;

      function etaAt(t) {
        var w0 = 0, s0 = 0, k;
        for (k = 0; k <= t; k++) { w0 += hist[k]; s0 += k * hist[k]; }
        var w1 = total - w0;
        if (w0 === 0 || w1 === 0 || varAll <= 0) return 0;
        var m0 = s0 / w0, m1 = (sumAll - s0) / w1;
        return (w0 / total) * (w1 / total) * (m0 - m1) * (m0 - m1) / varAll;
      }

      /* --- 適応的：画素ごとのしきい値の面を作る --- */
      var mp = null;
      if (p.method === 'adaptive') {
        if (p.stat === 'gauss') {
          mp = U.gaussianBlurPlane(g, w, h, Math.max(0.6, p.radius / 2));
        } else {
          /* 積分画像 S(x, y) = 左上の矩形の合計。境界を扱いやすいよう (w+1)×(h+1) */
          var iw = w + 1;
          var integ = new Float64Array(iw * (h + 1));
          for (y = 0; y < h; y++) {
            var rowSum = 0;
            for (x = 0; x < w; x++) {
              rowSum += g[y * w + x];
              integ[(y + 1) * iw + (x + 1)] = integ[y * iw + (x + 1)] + rowSum;
            }
          }
          /* 窓は画像の中に収める（外へはみ出したぶんは数えない）。
             鏡映で埋めるより、縁で窓が小さくなるほうが二値化では素直に見える */
          mp = new Float32Array(n);
          var r = p.radius;
          for (y = 0; y < h; y++) {
            var y0 = y - r; if (y0 < 0) y0 = 0;
            var y1 = y + r + 1; if (y1 > h) y1 = h;
            for (x = 0; x < w; x++) {
              var x0 = x - r; if (x0 < 0) x0 = 0;
              var x1 = x + r + 1; if (x1 > w) x1 = w;
              var s = integ[y1 * iw + x1] - integ[y0 * iw + x1]
                    - integ[y1 * iw + x0] + integ[y0 * iw + x0];
              mp[y * w + x] = s / ((y1 - y0) * (x1 - x0));
            }
          }
        }
      }

      var thrUsed = (p.method === 'fixed') ? p.thr : otsu;
      var bias = p.bias;

      /* --- 白になる画素の割合。kernel と同じ判定をここでも1回だけ回す --- */
      var white = 0, lim;
      for (i = 0; i < n; i++) {
        lim = mp ? (mp[i] - bias) : thrUsed;
        if ((g[i] > lim) !== !!p.invert) white++;
      }
      var pct = (white * 100 / n).toFixed(1);

      /* --- 右下に出す数値 --- */
      var rows;
      if (p.method === 'adaptive') {
        rows = [['閾値の決め方', p.stat === 'gauss' ? '適応的（ガウシアン加重）' : '適応的（平均）'],
                ['窓', (2 * p.radius + 1) + ' × ' + (2 * p.radius + 1) + ' px'],
                ['差の下駄 C', bias + ' 階調'],
                ['大津なら', otsu + ' 階調（参考）'],
                ['白の割合', pct + ' %']];
      } else {
        rows = [['閾値の決め方', p.method === 'otsu' ? '大津（自動）' : '固定（手で指定）'],
                ['閾値', thrUsed + ' 階調'],
                ['分離度 η', etaAt(thrUsed).toFixed(3) + (p.method === 'otsu' ? '（最大）' : '')],
                ['大津なら', otsu + ' 階調'],
                ['白の割合', pct + ' %']];
      }

      return { gray: g, mp: mp, thr: thrUsed, bias: bias, invert: !!p.invert,
               report: { rows: rows } };
    },

    /* 行帯 [y0, y1) だけを処理する。しきい値はもう決まっているので、比べるだけ */
    kernel: function (src, p, y0, y1, c) {
      var w = src.width;
      var out = new ImageData(w, y1 - y0), d = out.data;
      var g = c.gray, mp = c.mp, thr = c.thr, bias = c.bias, inv = c.invert;
      var x, y, i, o, lim, v;

      for (y = y0; y < y1; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          lim = mp ? (mp[i] - bias) : thr;
          v = (g[i] > lim) ? 255 : 0;
          if (inv) v = 255 - v;
          o = ((y - y0) * w + x) * 4;
          d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
        }
      }
      return out;
    },

    doc: {
      principle: '明るさがしきい値を超えたら白、超えなければ黒に振り分けて、画像を2値だけの絵にする処理です。ここから先の「形を数える」処理（面積、個数、輪郭、モルフォロジー）は、たいていこの二値画像を入口にします。\n\n難しいのは「しきい値をいくつにするか」だけで、この処理はその決め方を3通り用意してあります。固定は手で決める。大津はヒストグラムの形から自動で決める。適応的は1枚に1つではなく、画素ごとにその周りを見て決める。\n\nたとえるなら、答案の合格ラインの引き方です。固定は「60点以上」と先に決め打つやり方、大津は点数の分布を見て「ここで2つの山が一番きれいに割れる」ところに引くやり方、適応的は「クラスごとの平均点を基準に引く」やり方です。教室によって難易度が違うなら、最後のやり方でないと公平になりません。',
      formula: '固定・大津：g(x, y) = 255 if f(x, y) > t, else 0\n\n大津：t = argmax σ²_b(t)、σ²_b(t) = ω₀(t)·ω₁(t)·( μ₀(t) − μ₁(t) )²\n　　ω は各クラスの画素の割合、μ は各クラスの平均。分離度 η = σ²_b / σ²_total\n\n適応的：g(x, y) = 255 if f(x, y) > mean_W(x, y) − C\n　　mean_W は (x, y) を中心とする窓 W の平均。積分画像 S を使うと\n　　窓の合計 = S(x₁,y₁) − S(x₀,y₁) − S(x₁,y₀) + S(x₀,y₀) の引き算3回で出る',
      notes: [
        'まず〈幾何図形〉サンプルで「固定」を選び、閾値を動かしてください。右下に出る「分離度 η」が一番大きくなるところを手で探して、そのあと「大津」に切り替えると、同じ値に落ち着きます。大津がやっているのは、この手探りを 256 通り全部試すことだけです。',
        '大津の前提は「ヒストグラムに山が2つある」ことです。〈グレー階段＋ランプ〉のように山がたくさんある絵や、〈ゾーンプレート〉のように山が1つしかない絵では、出てくる閾値に意味がありません。分離度 η がその目安になります。η が 0.7 を下回るようなら、大津の答えは信用しないほうがよいと思ってください。',
        '〈低コントラスト（暗部にディテール）〉サンプルで、大津と適応的を切り替えてみてください。この絵は左上が暗く右下が明るいので、1枚に1つの閾値では、暗い側が全部黒に、明るい側が全部白に潰れます。適応的にすると、どちらの側の細かい模様も同じように出ます。照明のムラがある書類をスキャンしたときに起きることと同じです。',
        '適応的の「差の下駄 C」は、周りの平均とほとんど同じ明るさの画素をどちらに寄せるかの調整です。C を 0 にすると、真っ平らな場所（周りと同じ明るさ）ではノイズの上下だけで白黒が決まってしまい、ごま塩のような模様が出ます。C を少し足すと、しきい値が平均より C だけ下がるので、平坦なところはまとめて白に倒れて模様が消えます。書類のスキャンで「地の紙は白、文字だけ黒」にしたいときに効くのがこの下駄です。逆に C をマイナスにすると平坦なところが黒く塗り潰れるので、動かすなら 0 以上が実用の範囲です。',
        '窓の平均は積分画像で出しています。窓の中を毎回足すと窓の面積に比例して重くなりますが、積分画像を1枚作っておけば、どんな大きさの窓でも足し引き4回で済みます。窓の半径を 3 から 60 まで動かしても右下の「計算時間」がほとんど変わらないのは、そのためです。〈ガウシアン加重平均〉のほうは畳み込みなので、半径を上げると重くなります。見比べると、一定時間で済むありがたみが分かります。なお、この処理の「計算時間」はベンチマークと同じ測り方で出しています（必ず Web Worker で計算し、1回空回ししてから2回まわして速いほうを採る）。1回きりだとごみ集めやワーカーの温まり具合だけで数倍に振れて、「変わらない」ことが読めなくなるためです。比べるときは「計算時間」の行を見てください（「画面に出るまで」は3回まわすぶん3倍ほどになります）。',
        '窓を小さくしすぎると、太い線や広い面の内側が「周りと同じ明るさ」になってしまい、真ん中が抜けて輪郭だけが残ります。窓は「消したい構造よりも大きく」が目安です。〈ぼけた細線・格子〉サンプルで半径を動かすと、抜け始める境目が見えます。',
        '大津の閾値も窓の平均も、画像全体を見ないと出せないので、prepare で先に作ってしまっています。おかげで画素ごとの処理は「1つの数と比べるだけ」になり、帯の境目で閾値が食い違う心配がありません。ただし、この処理は複数のコアに分担させても速くなりません。重い計算がその前段にあり、そこはワーカーごとに丸ごと繰り返されてしまうからです。そのため FFT や比較と同じく、まとめて1つのワーカーへ渡しています。右下の「実行」欄に Worker 1 並列と出るのはそのためです。'
      ]
    }
  });
})();
