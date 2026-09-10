/* ImageLab — ops/morphology.js : モルフォロジー（膨張・収縮・オープニング・クロージング・トップハット）
 *
 * ■ 中身は「窓の中の最大／最小を取る」だけ
 *   膨張は最大、収縮は最小。その2つの組み合わせで残り3つができる。
 *     オープニング  = 収縮 → 膨張   （出っ張りと小さな白い粒を落とす）
 *     クロージング  = 膨張 → 収縮   （へこみと小さな黒い穴を埋める）
 *     トップハット  = 元 − オープニング（落とした小さいものだけを取り出す）
 *
 * ■ 白が膨らむ
 *   モルフォロジーは「明るいほう」を前景として扱う。黒い図形を膨らませたいときは
 *   〈白黒を入れ替える〉を入れる。入れ替えると膨張と収縮も入れ替わる（双対性）。
 *
 * ■ 四角と十字は分離できる
 *   四角の窓の最大は「横に最大 → 縦に最大」で同じ結果になる（ガウシアンの分離と同じ理屈）。
 *   十字は横線と縦線の和集合なので、横だけの最大と縦だけの最大を取って、
 *   その大きいほうを採ればよい。どちらも窓の面積ではなく一辺に比例する。
 *   円だけは分離できないので素朴に回している。
 *
 * ■ この処理は行帯に分けられない
 *   オープニングのように「収縮の結果を全部そろえてから膨張する」段があるため、
 *   prepare で最後まで作りきって、kernel はそこから切り出すだけにしてある。
 */
(function () {
  'use strict';
  var IL = window.IL, U = IL.util;

  IL.defineOp({
    id: 'morphology',
    category: 'binary',
    label: 'モルフォロジー（膨張・収縮・開閉）',

    params: [
      { key: 'opkind', type: 'select', label: '操作', value: 'dilate',
        options: [{ value: 'dilate', label: '膨張（白をふくらませる）' },
                  { value: 'erode', label: '収縮（白をやせさせる）' },
                  { value: 'open', label: 'オープニング（収縮→膨張）' },
                  { value: 'close', label: 'クロージング（膨張→収縮）' },
                  { value: 'tophat', label: 'トップハット（元 − オープニング）' }] },

      { key: 'shape', type: 'select', label: '構造要素の形', value: 'rect',
        options: [{ value: 'rect', label: '四角（分離できる）' },
                  { value: 'cross', label: '十字（分離できる）' },
                  { value: 'disk', label: '円（分離できない）' }] },
      { key: 'radius', type: 'range', label: '構造要素の半径', min: 1, max: 8, step: 1, value: 2,
        format: function (v) { return v + ' px（差し渡し ' + (2 * v + 1) + ' px）'; } },
      { key: 'iter', type: 'range', label: '反復回数', min: 1, max: 3, step: 1, value: 1,
        format: function (v) { return v + ' 回'; } },

      { key: 'pre', type: 'checkbox', label: '先に二値化する（大津）', value: true },
      { key: 'invert', type: 'checkbox', label: '白黒を入れ替える', value: false },
      { key: 'stretch', type: 'checkbox', label: '結果を伸ばして表示する', value: true,
        when: function (p) { return p.opkind === 'tophat'; } }
    ],

    /* 段のあいだで画像全体がそろっている必要があるので、帯には分けない */
    halo: function () { return 1e9; },

    /* 構造要素の形で処理時間がどう変わるかを見せる処理なので、
       軽い四角・十字も必ずワーカーへ回して経路をそろえる。
       メインスレッドで走らせると GC が挟まって数字が読めない（js/worker.js の J.run） */
    route: 'worker',

    /* 処理時間を見せるので、1回空回ししてから2回まわして速いほうを採る。
       1回きりだと、ワーカーが温まっていない・PC が混んでいる、といった事情だけで
       数倍に振れる（js/worker.js の workerBody） */
    bench: 2,

    cost: function (w, h, p) {
      var r = p.radius, per;
      if (p.shape === 'disk') {
        var cnt = 0, dx, dy;
        for (dy = -r; dy <= r; dy++) {
          for (dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) cnt++;
        }
        per = cnt;                       /* 素朴に窓ぶん回す */
      } else {
        per = 2 * (2 * r + 1);           /* 横1回＋縦1回 */
      }
      /* 開閉は膨張と収縮で2回ぶん。トップハットは開いてから引き算 */
      var passes = (p.opkind === 'dilate' || p.opkind === 'erode') ? 1 : 2;
      /* 係数は node docs/_bench.js の実測から。1画素1タップあたり 4.2e-6 ms。
         窓が小さいうちは相対的に割高（ループの外側が効く）だが、
         Worker に回すかの判断にしか使わないので、この1本で足りる */
      var base = w * h * per * passes * p.iter * 4.2e-6;
      if (p.pre) base += w * h * 1.6e-5;          /* 先に二値化するぶん */
      return base + w * h * 1.0e-5;               /* グレー化と書き出し */
    },

    prepare: function (src, p) {
      var w = src.width, h = src.height, n = w * h;
      var i;

      /* --- 1. 白黒の面を用意する --- */
      var g;
      if (p.pre) {
        /* 二値化の中身は既存の処理をそのまま呼ぶ（アルゴリズムを写さない）。
           IL.opById を直接引くと Worker の中で壊れるので U.opKernel を使う */
        var tp = { method: 'otsu', thr: 128, radius: 16, bias: 6, stat: 'mean', invert: false };
        var tc = U.opPrepare('threshold')(src, tp);
        g = U.toGrayPlane(U.opKernel('threshold')(src, tp, 0, h, tc));
      } else {
        g = U.toGrayPlane(src);
      }
      if (p.invert) { for (i = 0; i < n; i++) g[i] = 255 - g[i]; }

      /* --- 2. 窓の最大／最小 ---
         端は複製で埋める（画像の外に「もっと明るい／暗い画素」を作らないため）。 */
      function lineRun(a, r, isMax, vertical) {
        var out = new Float32Array(a.length);
        var x, y, k, idx, v, best, base;
        if (!vertical) {
          for (y = 0; y < h; y++) {
            base = y * w;
            for (x = 0; x < w; x++) {
              best = a[base + x];
              for (k = -r; k <= r; k++) {
                idx = x + k;
                if (idx < 0) idx = 0; else if (idx >= w) idx = w - 1;
                v = a[base + idx];
                if (isMax ? (v > best) : (v < best)) best = v;
              }
              out[base + x] = best;
            }
          }
        } else {
          for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
              best = a[y * w + x];
              for (k = -r; k <= r; k++) {
                idx = y + k;
                if (idx < 0) idx = 0; else if (idx >= h) idx = h - 1;
                v = a[idx * w + x];
                if (isMax ? (v > best) : (v < best)) best = v;
              }
              out[y * w + x] = best;
            }
          }
        }
        return out;
      }

      /* 円のオフセット表。分離できないので、ここだけ素朴に回る */
      var offs = null;
      if (p.shape === 'disk') {
        offs = [];
        var dx, dy;
        for (dy = -p.radius; dy <= p.radius; dy++) {
          for (dx = -p.radius; dx <= p.radius; dx++) {
            if (dx * dx + dy * dy <= p.radius * p.radius + 0.5) offs.push(dy * w + dx, dx, dy);
          }
        }
      }

      function morphPass(a, isMax) {
        var r = p.radius, k, x, y, v, best, o;
        if (p.shape === 'rect') return lineRun(lineRun(a, r, isMax, false), r, isMax, true);
        if (p.shape === 'cross') {
          var hh = lineRun(a, r, isMax, false), vv = lineRun(a, r, isMax, true);
          var cr = new Float32Array(a.length);
          for (k = 0; k < a.length; k++) {
            cr[k] = isMax ? (hh[k] > vv[k] ? hh[k] : vv[k])
                          : (hh[k] < vv[k] ? hh[k] : vv[k]);
          }
          return cr;
        }
        var out = new Float32Array(a.length);
        for (y = 0; y < h; y++) {
          for (x = 0; x < w; x++) {
            best = a[y * w + x];
            for (k = 0; k < offs.length; k += 3) {
              var nx = x + offs[k + 1], ny = y + offs[k + 2];
              if (nx < 0) nx = 0; else if (nx >= w) nx = w - 1;
              if (ny < 0) ny = 0; else if (ny >= h) ny = h - 1;
              v = a[ny * w + nx];
              if (isMax ? (v > best) : (v < best)) best = v;
            }
            o = y * w + x;
            out[o] = best;
          }
        }
        return out;
      }

      /* --- 3. 操作を組み立てる --- */
      var res = g, it;
      for (it = 0; it < p.iter; it++) {
        if (p.opkind === 'dilate') res = morphPass(res, true);
        else if (p.opkind === 'erode') res = morphPass(res, false);
        else if (p.opkind === 'close') res = morphPass(morphPass(res, true), false);
        else res = morphPass(morphPass(res, false), true);   /* open と tophat の下ごしらえ */
      }

      if (p.opkind === 'tophat') {
        var top = new Float32Array(n), hi = 0;
        for (i = 0; i < n; i++) {
          top[i] = g[i] - res[i];
          if (top[i] < 0) top[i] = 0;
          if (top[i] > hi) hi = top[i];
        }
        if (p.stretch && hi > 0) { for (i = 0; i < n; i++) top[i] = top[i] * 255 / hi; }
        res = top;
      }

      /* --- 4. 右下に出す数値 --- */
      var shapeName = { rect: '四角', cross: '十字', disk: '円' }[p.shape];
      var seCount;
      if (p.shape === 'rect') seCount = (2 * p.radius + 1) * (2 * p.radius + 1);
      else if (p.shape === 'cross') seCount = 4 * p.radius + 1;
      else seCount = offs.length / 3;

      var kindName = { dilate: '膨張', erode: '収縮', open: 'オープニング',
                       close: 'クロージング', tophat: 'トップハット' }[p.opkind];

      var rows = [['操作', kindName],
                  ['構造要素', shapeName + ' ' + (2 * p.radius + 1) + ' × ' + (2 * p.radius + 1) +
                               '（' + seCount + ' 画素）'],
                  ['反復', p.iter + ' 回']];

      if (p.pre) {
        var b0 = 0, b1 = 0;
        for (i = 0; i < n; i++) { if (g[i] > 127) b0++; if (res[i] > 127) b1++; }
        rows.push(['白の割合', (b0 * 100 / n).toFixed(1) + ' % → ' + (b1 * 100 / n).toFixed(1) + ' %']);
      } else {
        var m0 = 0, m1 = 0;
        for (i = 0; i < n; i++) { m0 += g[i]; m1 += res[i]; }
        rows.push(['平均の明るさ', (m0 / n).toFixed(1) + ' → ' + (m1 / n).toFixed(1)]);
      }

      return { out: U.grayToImageData(res, w, h), report: { rows: rows } };
    },

    kernel: function (src, p, y0, y1, c) { return U.rowsOf(c.out, y0, y1); },

    doc: {
      principle: '「構造要素」と呼ぶ小さな窓を画像の上で滑らせ、窓の中の最大値（膨張）か最小値（収縮）を採る処理です。二値画像なら「窓の中に白が1画素でもあれば白にする」のが膨張、「窓が全部白のときだけ白を残す」のが収縮になります。形そのものを太らせたり痩せさせたりする操作なので、面積や個数を数える前の下ごしらえによく使われます。\n\nこの2つを組み合わせると、大きさで選り分けができるようになります。収縮してから膨張する（オープニング）と、構造要素より細いものは収縮の段で消えてしまい、膨張しても戻ってきません。太いものだけが元の大きさに戻ります。逆順（クロージング）なら、小さな穴やすき間だけが埋まります。\n\nたとえるなら、ふるいです。オープニングは目より小さい粒を落とすふるい、クロージングは隙間に砂を流し込んで埋める作業。トップハットは「ふるいで落ちたものだけを集める」操作にあたります。',
      formula: '膨張：(f ⊕ B)(x) = max{ f(x − b) : b ∈ B }\n収縮：(f ⊖ B)(x) = min{ f(x + b) : b ∈ B }\nオープニング：f ∘ B = (f ⊖ B) ⊕ B　　クロージング：f • B = (f ⊕ B) ⊖ B\nトップハット：f − (f ∘ B)\n双対性：f ⊕ B = 255 − ( (255 − f) ⊖ B )',
      notes: [
        'この処理は「明るいほう」を前景として扱うので、白がふくらみます。〈幾何図形〉のように黒い図形が白い紙に載っている絵では、膨張を選ぶと図形のほうが痩せて見えます。〈白黒を入れ替える〉を入れると図形が白になり、今度は図形がふくらみます。膨張と収縮は白黒を入れ替えると入れ替わる、というのがモルフォロジーの双対性です。式にすると f ⊕ B = 255 − ((255 − f) ⊖ B)。',
        '〈ソルト＆ペッパーノイズ〉サンプルで、オープニングとクロージングを見比べてください。オープニングは白い粒（ソルト）だけを消し、クロージングは黒い粒（ペッパー）だけを消します。両方消したいなら片方をかけてからもう片方をかけます。メディアンが一度に両方消すのと比べると、モルフォロジーは「どちらを消すか選べる」のが持ち味だと分かります。',
        'オープニングとクロージングは冪等です。つまり2回かけても1回かけたのと同じ結果になります（反復回数を2にしても絵が変わらないのはそのため。膨張と収縮のほうは反復するたびに進みます）。「これ以上ふるいにかけても落ちるものはない」という、ふるいとしての性質そのものです。',
        'トップハットは「元の絵 − オープニングした絵」です。オープニングが太いものだけを残すので、引き算すると細いもの・小さいものだけが残ります。〈先に二値化する〉を外してグレースケールのまま〈低コントラスト（暗部にディテール）〉にかけると、大きな明暗のムラだけがオープニングで残り、引き算で消えます。照明ムラを取り除いて細部だけ取り出す、という実務でよくある使い方がそのまま見えます。構造要素の半径を「残したいものより大きく」するのがコツです。',
        '構造要素の形で結果が変わります。四角は角ばった太り方をし、円は等方に太ります。十字は縦横だけに伸びるので、斜めの線には効きが弱くなります。〈幾何図形〉の斜線の束にかけると違いがはっきり出ます。理屈のうえでは円が素直ですが、四角と十字には「分離できる」という実装上の利点があります。',
        '四角の窓の最大値は「横に最大 → 縦に最大」の2段で同じ結果になります。ガウシアンの分離と同じ理屈で、窓の面積 k² に比例していた計算が一辺 2k で済みます。十字は横線と縦線の和集合なので、横だけの最大と縦だけの最大を取って大きいほうを採れば出ます。円だけはこの手が使えないので素朴に回しています。640×480・半径8の膨張で、四角が 50 ms、十字が 51 ms なのに対し、円は 305 ms。6倍の差です。3つを切り替えて右下の「計算時間」を見比べると、分離できることの値打ちがそのまま読めます。',
        'この処理の「計算時間」は、**ベンチマークと同じ測り方**で出しています。①軽い四角や十字でも必ず Web Worker で計算する（右下の「実行」欄がいつも Worker 1 並列になるのはそのため）。②1回空回ししてから2回まわし、**速かったほうを採る**（「（2回の最小）」という但し書きが付きます）。どちらも速くするためではなく、**3つの形を同じ条件で測るため**です。\n\nなぜここまでするかというと、1回きりの計測が当てにならないからです。実測で、同じ設定・同じ経路のまま円が 192 ms と 447 ms になりました（2.3倍）。じゃまが入る理由は2つあって、1つはメインスレッドで計算するとページの大きなデータごしに走るためごみ集め（GC）が挟まること、もう1つはワーカーが作られた直後だとコードがまだ最適化されていないこと。どちらも「じゃまが入った回」を作るので、**最小値を採れば「じゃまが入らなければこの速さ」**が読めます。node docs/_bench.js が「1回空回ししてから3回計測してその中央値」を採っているのと同じ理屈です。\n\nそのぶん計算は3回まわるので、「画面に出るまで」は計算時間の3倍ほどになります。速さを見せたいなら測り方を揃える、という話で、性能を語るときの心得そのものです。',
        'さらに速くする定石として、van Herk / Gil-Werman のアルゴリズムがあります。1次元の最大値を「前向きの累積最大」と「後ろ向きの累積最大」の2本に分けて持つと、窓の大きさによらず1画素あたり定数回で済みます。ここでは実装していませんが、二値化の窓平均を積分画像で出したのと同じ発想です。',
        'オープニングは「収縮の結果が全部そろってから膨張する」ので、行帯に切って別々に計算できません。帯の境目で、隣の帯にはみ出した収縮の結果が使えないためです。そこで prepare で最後まで作りきり、丸ごと1つのワーカーに渡しています。'
      ]
    }
  });
})();
