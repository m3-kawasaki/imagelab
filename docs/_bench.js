/* ImageLab — 開発用ベンチマーク（node docs/_bench.js [幅] [高さ]）
 *
 * 測っているのは「1スレッドで一枚を通しで処理したときの時間」。
 * ブラウザでは重い処理を Web Worker が分担するので、体感はこれより速くなる
 * （12コア機で3〜4倍）。ここの数字は op.cost の係数を決める材料と、
 * アルゴリズム自体の速さを比べるためのもの。
 *
 * vm.createContext を挟むとコンテキスト跨ぎで実測が数十倍に膨れるので、
 * ここでは同一レルムで eval して素の速度を測っている。 */
'use strict';
const fs = require('fs'), path = require('path');

global.window = {};
global.ImageData = class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
};

const root = path.join(__dirname, '..');
/* Node 22 の navigator は getter だけなので、上書きではなく差し替える */
Object.defineProperty(global, 'navigator', {
  value: { hardwareConcurrency: 4 }, configurable: true, writable: true
});

['js/core.js', 'js/fft.js', 'js/registry.js', 'js/worker.js',
 'js/ops/tone.js', 'js/ops/gamma.js', 'js/ops/histeq.js',
 'js/ops/clahe.js', 'js/ops/blur.js', 'js/ops/median.js', 'js/ops/bilateral.js',
 'js/ops/unsharp.js', 'js/ops/fft.js', 'js/ops/fftfilter.js', 'js/ops/fftmask.js',
 'js/ops/noise.js', 'js/ops/denoisecmp.js',
 'js/ops/sobel.js', 'js/ops/laplacian.js', 'js/ops/canny.js',
  'js/ops/threshold.js', 'js/ops/morphology.js', 'js/ops/demosaic.js',
  'js/ops/affine.js', 'js/ops/lensdist.js']
  .forEach(f => (0, eval)(fs.readFileSync(path.join(root, f), 'utf8')));
const IL = global.window.IL;

const W = Number(process.argv[2] || 1024), H = Number(process.argv[3] || 768);
const img = new ImageData(W, H);
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < W * H; i++) {
  const v = 40 + 150 * ((i % W) / W) + (rnd() - 0.5) * 25;
  img.data[i * 4] = v; img.data[i * 4 + 1] = v * .9 + 12; img.data[i * 4 + 2] = v * .7 + 40; img.data[i * 4 + 3] = 255;
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
console.log(`${W}×${H}（${(W * H / 1e6).toFixed(2)} MP）  1スレッドでの実測`);
console.log('※1回空回ししてから3回計測、その中央値');
console.log('※「見積」は op.cost の値。Worker に回すかの判断に使う（しきい値 ' +
            IL.jobs.threshold + ' ms）。桁が合っていればよい\n');
console.log('処理'.padEnd(22) + '実測'.padStart(8) + '見積'.padStart(9) + '  行き先');

const cases = [];
IL.ops.forEach(op => cases.push([op.label, op.id, {}]));
cases.push(['  └ bilateral σs=6', 'bilateral', { sigmaS: 6 }]);
cases.push(['  └ median 半径3', 'median', { radius: 3 }]);
cases.push(['  └ median 半径5', 'median', { radius: 5 }]);
cases.push(['  └ blur σ=10', 'blur', { kind: 'gauss', sigma: 10 }]);
cases.push(['  └ clahe tiles=16', 'clahe', { tiles: 16 }]);
cases.push(['  └ fftfilter 輝度のみ', 'fftfilter', { channels: 'luma' }]);
cases.push(['  └ fftfilter スペクトル表示', 'fftfilter', { show: 'spectrum' }]);
cases.push(['  └ fftmask 輝度のみ', 'fftmask', { channels: 'luma' }]);
cases.push(['  └ noise ショット', 'noise', { kind: 'shot' }]);
cases.push(['  └ noise 周期（斜め縞）', 'noise', { kind: 'periodic' }]);
cases.push(['  └ 比較 単体表示', 'denoisecmp', { view: 'median' }]);
cases.push(['  └ 比較 σs=3', 'denoisecmp', { bsigmaS: 3 }]);
cases.push(['  └ 二値化 固定', 'threshold', { method: 'fixed' }]);
cases.push(['  └ 二値化 適応的 半径3', 'threshold', { method: 'adaptive', radius: 3 }]);
cases.push(['  └ 二値化 適応的 半径60', 'threshold', { method: 'adaptive', radius: 60 }]);
cases.push(['  └ 二値化 適応的 ガウシアン', 'threshold', { method: 'adaptive', stat: 'gauss' }]);
cases.push(['  └ モルフォ 四角 r=2', 'morphology', { shape: 'rect', radius: 2 }]);
cases.push(['  └ モルフォ 四角 r=8', 'morphology', { shape: 'rect', radius: 8 }]);
cases.push(['  └ モルフォ 十字 r=8', 'morphology', { shape: 'cross', radius: 8 }]);
cases.push(['  └ モルフォ 円 r=8', 'morphology', { shape: 'disk', radius: 8 }]);
cases.push(['  └ モルフォ 開 円 r=8', 'morphology', { opkind: 'open', shape: 'disk', radius: 8 }]);
cases.push(['  └ モルフォ 開 四角 r=8×3', 'morphology', { opkind: 'open', shape: 'rect', radius: 8, iter: 3 }]);
cases.push(['  └ デモザイク メディアン0', 'demosaic', { med: 0 }]);
cases.push(['  └ デモザイク メディアン3', 'demosaic', { med: 3 }]);
cases.push(['  └ デモザイク 単体表示', 'demosaic', { view: 'ahd' }]);
cases.push(['  └ アフィン 最近傍', 'affine', { interp: 'nearest' }]);
cases.push(['  └ アフィン バイキュービック', 'affine', { interp: 'bicubic' }]);
cases.push(['  └ アフィン 往復', 'affine', { roundtrip: true }]);
cases.push(['  └ 歪み 補正', 'lensdist', { kind: 'correct' }]);
cases.push(['  └ 歪み バイキュービック', 'lensdist', { interp: 'bicubic' }]);
cases.push(['  └ 歪み 往復', 'lensdist', { kind: 'roundtrip' }]);

for (const [label, id, over] of cases) {
  const op = IL.opById[id];
  const p = Object.assign(IL.defaultParams(op), over);
  op.apply(img, p);                       /* JIT を温める */
  const ts = [];
  for (let k = 0; k < 3; k++) { const t = now(); op.apply(img, p); ts.push(now() - t); }
  ts.sort((a, b) => a - b);
  const ms = ts[1];
  const est = op.cost ? op.cost(W, H, p) : 0;
  const dest = (typeof op.kernel !== 'function') ? 'メインスレッド（分割なし）'
             : (op.route === 'worker') ? 'Worker（経路を固定）'
             : (est < IL.jobs.threshold) ? 'メインスレッド（軽いので同期）'
             : 'Worker で分担';
  console.log(label.padEnd(24) + String(ms.toFixed(0)).padStart(5) + ' ms' +
              (est ? String(est.toFixed(0)).padStart(6) + ' ms' : '     —  ') + '  ' + dest);
}
