/* ImageLab — registry.js
 * 処理の登録テーブル。UI はこのテーブルを読んで自動生成する。
 * 処理を1つ増やすときは js/ops/ にファイルを1つ足して
 * index.html に <script> を1行足すだけでよい。
 */
(function () {
  'use strict';
  var IL = (window.IL = window.IL || {});

  /* カテゴリ。第2階層以降を足すときはここに追記する */
  IL.categories = [
    { id: 'basic', label: '基本' },
    { id: 'point', label: '点処理' },
    { id: 'spatial', label: '空間フィルタ' },
    { id: 'freq', label: '周波数領域' },
    { id: 'noise', label: 'ノイズと評価' },
    { id: 'edge', label: 'エッジ検出' },
    { id: 'binary', label: '二値化とモルフォロジー' },
    { id: 'sensor', label: 'センサと幾何' }
  ];

  IL.ops = [];
  IL.opById = {};

  /* op = {
   *   id, category, label,
   *   params: [ {key, type:'range'|'select'|'checkbox'|'curve'|'spectrum', ...} ],
   *   apply: function(srcImageData, p) -> ImageData,
   *   doc: { principle, formula, notes:[...] }
   * }
   *
   * --- 重い処理を Web Worker に逃がしたいとき ---
   * apply の代わりに、次の4つを書く（apply は自動で組み立てられる）。
   *
   *   kernel:  function (src, p, y0, y1, ctx) -> ImageData（高さ y1-y0）
   *              行帯 [y0, y1) だけを処理して返す。src は常に画像全体なので、
   *              窓が帯の外にはみ出しても結果は一枚で計算したときと一致する。
   *   prepare: function (src, p) -> ctx                       … 任意
   *              重みの表など、帯をまたいで使い回す下ごしらえ。
   *   cost:    function (w, h, p) -> おおよそのミリ秒          … 任意
   *              Worker に回すかどうかの判断だけに使う。精度は要らない。
   *   halo:    function (p) -> 帯の外を何行読むか              … 任意
   *              帯を薄くしすぎて無駄が増えるのを防ぐために使う。
   *              画像全体を一度に扱う処理（FFT など）は、ここに画像の高さより
   *              大きい値を返すと帯が1本にまとまり、丸ごと1つのワーカーへ渡る。
   *   stages:  function (p) -> 段数（既定 1）                  … 任意
   *              前の段の結果を次の段の入力にする処理（反復など）向け。
   *   route:   'worker'                                       … 任意
   *              見積りが軽くても必ずワーカーへ回す。
   *              **処理時間そのものを見せる処理でだけ立てること。**
   *              メインスレッドで走らせると、ページの大きなヒープを抱えたまま
   *              計算するので GC が挟まり、実測が2〜5倍に膨れて安定しない。
   *              経路を固定しておけば、設定を切り替えた前後の数字が素直に比べられる。
   *              詳しくは js/worker.js の J.run のコメント。
   *   bench:   計測回数（整数）                                 … 任意
   *              立てると prepare を「1回空回し → この回数まわして最小を採る」で測る。
   *              route と同じく**処理時間を見せる処理でだけ**立てること。
   *              1回きりだと、ワーカーが温まっていない・PC が混んでいる、といった
   *              事情だけで2倍前後に振れる（実測。同じ設定・同じ経路で
   *              モルフォロジーの円が 192 ms と 447 ms になった）。
   *              そのぶん計算は bench+1 回まわるので、「画面に出るまで」は
   *              その倍数だけ伸びる。
   *
   * --- 画像のほかに数値を返したいとき ---
   * prepare が返す ctx に report を入れると、それがページ側の onDone まで届く。
   *   prepare: function (src, p) { … return { out: img, report: { rows: [['PSNR','31.2 dB']] } }; }
   * report は Worker との間で構造化複製されるので、数と文字列と配列だけで組むこと
   * （関数や ImageData は入れられない）。ページ側の使い方は js/main.js の showStats。
   *   ・report.rows  … 右下の stats 欄に足す行 [ラベル, 値] の並び
   *   ・report.tiles … ビューアに重ねる見出し（横並び比較のタイル用）
   *
   * --- 別の処理を呼びたいとき ---
   * U.opPrepare(id) / U.opKernel(id) を使う。IL.opById を直接引くと Worker で壊れる。
   *
   * kernel と prepare は Worker の中でも動くので、次の2つを守ること。
   *   1. 外側の変数を参照しない（U.〇〇 と、引数で渡ったものだけ使う）
   *   2. 「function (…) {…}」の形で書く（短縮記法は文字列化できない）
   * 詳しくは js/worker.js の頭のコメントを参照。 */
  IL.defineOp = function (op) {
    if (IL.opById[op.id]) { console.warn('op id が重複しています: ' + op.id); return; }
    op.params = op.params || [];
    op.doc = op.doc || {};

    /* kernel だけ書いてあれば apply は自動で作る。
     * 全行を一度に処理するだけなので、Worker を使わない経路（軽いとき・Node の
     * セルフテスト）でも今までと同じ結果になる。
     *
     * 第3引数 sink は任意。渡すと、prepare が ctx.report に入れた数値を
     * sink.report で受け取れる（Worker 経由のときは js/worker.js が同じことをする）。 */
    if (!op.apply && typeof op.kernel === 'function') {
      op.apply = function (src, p, sink) {
        var n = op.stages ? op.stages(p) : 1;
        var cur = src, out = src;
        for (var s = 0; s < n; s++) {
          var ctx = op.prepare ? op.prepare(cur, p) : null;
          if (sink && ctx && ctx.report) sink.report = ctx.report;
          out = op.kernel(cur, p, 0, cur.height, ctx);
          cur = out;
        }
        return out;
      };
    }

    IL.ops.push(op);
    IL.opById[op.id] = op;
  };

  /* パラメータ定義の初期値をオブジェクトに展開する */
  IL.defaultParams = function (op) {
    var p = {};
    op.params.forEach(function (d) {
      p[d.key] = (typeof d.value === 'function') ? d.value() : IL.cloneValue(d.value);
    });
    return p;
  };

  IL.cloneValue = function (v) {
    if (Array.isArray(v)) return v.map(function (x) { return Array.isArray(x) ? x.slice() : x; });
    return v;
  };

  /* --- 「原画（処理なし）」だけはここで定義しておく --- */
  IL.defineOp({
    id: 'none',
    category: 'basic',
    label: '原画（処理なし）',
    params: [],
    apply: function (src) { return IL.util.cloneImageData(src); },
    doc: {
      principle: '何も加工せずそのまま表示します。読み込んだ画像の素性（ヒストグラムの形、ノイズの量、白飛び・黒つぶれの有無）を確認するための状態です。',
      formula: 'g(x, y) = f(x, y)',
      notes: [
        'まずここでヒストグラムを見てから処理を選ぶと、狙いが説明しやすくなります。',
        '右下の「計算時間」はこの状態でもコピーのコストぶんだけ出ます。他の処理の目安と比べるときの基準にしてください。なお時間は2つ出しています。「計算時間」は処理の中身だけを測ったもので、処理どうしを比べるのはこちら。「画面に出るまで」は結果が返るまでの実時間で、軽い処理では直前の描画の割り込みが乗るぶんだけ大きく、Web Worker に逃がした処理では計算が別スレッドで進むぶんだけ小さく出ます。'
      ]
    }
  });
})();
