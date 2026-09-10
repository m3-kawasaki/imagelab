/* ImageLab — 開発用セルフテスト（Node で実行する。ブラウザからは読み込まない）
 *
 *   node docs/_selftest.js
 *
 * 目的：画像処理の中身だけを DOM 抜きで動かし、
 *   ・例外を出さないか
 *   ・出力サイズが入力と一致するか
 *   ・恒等であるべき設定でちゃんと恒等になるか
 * を確かめる。UI の確認はブラウザで行う。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* --- ブラウザ API の最小限のスタブ --- */
class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
}
/* setTimeout は「予約だけして走らせない」スタブ。
   IL.jobs.run が経路（sync / main / worker）をどう決めるかだけを見たいので、
   実際の計算まで走らせる必要はない。走らせてしまうと、このテストが
   同期で完結しなくなる。 */
const sandbox = { window: {}, ImageData, console, Math, performance: { now: () => Date.now() },
  setTimeout: () => 0, clearTimeout: () => {},
  navigator: { hardwareConcurrency: 4 } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const root = path.join(__dirname, '..');
const files = ['js/core.js', 'js/fft.js', 'js/registry.js', 'js/worker.js',
  'js/ops/tone.js', 'js/ops/gamma.js', 'js/ops/histeq.js', 'js/ops/clahe.js',
  'js/ops/blur.js', 'js/ops/median.js', 'js/ops/bilateral.js', 'js/ops/unsharp.js',
  'js/ops/fft.js', 'js/ops/fftfilter.js', 'js/ops/fftmask.js',
  'js/ops/noise.js', 'js/ops/denoisecmp.js',
  'js/ops/sobel.js', 'js/ops/laplacian.js', 'js/ops/canny.js',
  'js/ops/threshold.js', 'js/ops/morphology.js', 'js/ops/demosaic.js',
  'js/ops/affine.js', 'js/ops/lensdist.js'];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const IL = sandbox.window.IL;

/* --- テスト画像：グラデ＋段差＋ノイズ＋孤立点 --- */
function testImage(w, h) {
  const img = new ImageData(w, h), d = img.data;
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0, j = 0; y < h; y++) {
    for (let x = 0; x < w; x++, j += 4) {
      let v = 40 + 150 * (x / w) + (y > h / 2 ? 50 : 0) + (rnd() - 0.5) * 20;
      if (rnd() < 0.01) v = rnd() < 0.5 ? 0 : 255;
      d[j] = v; d[j + 1] = v * 0.9 + 12; d[j + 2] = v * 0.7 + 40; d[j + 3] = 255;
    }
  }
  return img;
}

const W = 96, H = 72;
const src = testImage(W, H);
let fails = 0, checks = 0;

function check(name, cond, detail) {
  checks++;
  if (!cond) { fails++; console.log('  NG  ' + name + (detail ? '  … ' + detail : '')); }
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 === 3) continue;
    m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  }
  return m;
}

/* --- 1. 全処理を既定パラメータで走らせる --- */
console.log('1) 既定パラメータで全処理を実行');
for (const op of IL.ops) {
  const p = IL.defaultParams(op);
  let out, err = null, ms;
  const t0 = Date.now();
  try { out = op.apply(src, p); } catch (e) { err = e; }
  ms = Date.now() - t0;
  check(op.id + ' が例外を出さない', !err, err && err.stack);
  if (out) {
    check(op.id + ' の出力サイズが一致', out.width === W && out.height === H);
    let alphaOK = true, finite = true;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] !== 255) alphaOK = false;
      if (!Number.isFinite(out.data[i])) finite = false;
    }
    check(op.id + ' のアルファが 255', alphaOK);
    check(op.id + ' に NaN が無い', finite);
    console.log('     ' + op.id.padEnd(11) + ' ' + String(ms).padStart(4) + ' ms');
  }
}

/* --- 2. 恒等になるべき設定 --- */
console.log('2) 恒等チェック');
function ident(id, params, tol) {
  const op = IL.opById[id];
  const p = Object.assign(IL.defaultParams(op), params);
  const out = op.apply(src, p);
  const m = maxAbsDiff(src, out);
  check(id + ' が恒等（許容 ' + tol + '）', m <= tol, '最大差 ' + m);
}
ident('gamma', { gamma: 1.0 }, 1);
ident('tone', { curve: [[0, 0], [255, 255]] }, 1);
ident('histeq', { amount: 0 }, 1);
ident('clahe', { amount: 0 }, 1);
ident('unsharp', { amount: 0 }, 1);
ident('blur', { kind: 'gauss', sigma: 0.3 }, 6);   /* σ が十分小さければほぼ素通り */
/* FFT は往復して戻るか。全通過のマスク／しきい 0 のハイパスは通過率が全ビン 1 になる。
   ここが合っていれば、順変換・逆変換・2の冪への埋め方・切り戻しが全部そろっている */
ident('fftmask', {}, 1);
ident('fftfilter', { kind: 'highpass', cut: 0, channels: 'rgb' }, 1);
ident('fftfilter', { kind: 'highpass', cut: 0, edge: 'zero' }, 1);

/* --- 3. 個別の性質 --- */
console.log('3) 個別の性質');

/* トーンカーブ：単調増加のカーブなら LUT も単調増加（PCHIP の要件） */
{
  const lut = IL.util.curveLUT([[0, 0], [64, 40], [128, 128], [192, 216], [255, 255]]);
  let mono = true;
  for (let i = 1; i < 256; i++) if (lut[i] < lut[i - 1]) mono = false;
  check('curveLUT が単調（オーバーシュートしない）', mono);
  check('curveLUT の端が 0 と 255', lut[0] === 0 && lut[255] === 255, lut[0] + '/' + lut[255]);
}

/* ネガのプリセットは反転になる */
{
  const lut = IL.util.curveLUT([[0, 255], [255, 0]]);
  check('ネガの LUT が反転', Math.abs(lut[0] - 255) <= 1 && Math.abs(lut[255] - 0) <= 1 && Math.abs(lut[128] - 127) <= 2);
}

/* ガウシアンカーネルの総和が 1 */
{
  const k = IL.util.gaussianKernel1d(2.5);
  const s = k.reduce((a, b) => a + b, 0);
  check('ガウシアンカーネルの総和が 1', Math.abs(s - 1) < 1e-5, String(s));
}

/* 平滑化すると分散が下がる */
{
  const op = IL.opById['blur'];
  const out = op.apply(src, Object.assign(IL.defaultParams(op), { kind: 'gauss', sigma: 3 }));
  const vr = (img) => {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) { s += img.data[i]; s2 += img.data[i] ** 2; n++; }
    return s2 / n - (s / n) ** 2;
  };
  check('ガウシアンで分散が下がる', vr(out) < vr(src), vr(src).toFixed(1) + ' → ' + vr(out).toFixed(1));
}

/* メディアンは孤立点（ソルト＆ペッパー）を消す */
{
  const w = 41, h = 41;
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 128; img.data[i * 4 + 3] = 255;
  }
  const c = ((h >> 1) * w + (w >> 1)) * 4;
  img.data[c] = img.data[c + 1] = img.data[c + 2] = 255;
  const op = IL.opById['median'];
  const out = op.apply(img, IL.defaultParams(op));
  check('メディアンが孤立点を消す', out.data[c] === 128, String(out.data[c]));
}

/* Canny の各段階が全部動き、最終出力が2値になる */
{
  const op = IL.opById['canny'];
  for (const st of ['s1', 's2', 's3', 's4', 's5', 'final']) {
    const p = Object.assign(IL.defaultParams(op), { stage: st });
    let ok = true;
    try { op.apply(src, p); } catch (e) { ok = false; console.log('     ' + e.stack); }
    check('canny 段階 ' + st, ok);
  }
  const fin = op.apply(src, IL.defaultParams(op));
  let binary = true, edges = 0;
  for (let i = 0; i < fin.data.length; i += 4) {
    if (fin.data[i] !== 0 && fin.data[i] !== 255) binary = false;
    if (fin.data[i] === 255) edges++;
  }
  check('canny の最終出力が2値', binary);
  check('canny がエッジを検出している', edges > 0 && edges < W * H * 0.5, edges + ' 画素');
}

/* しきい値の大小を逆に入れても落ちない */
{
  const op = IL.opById['canny'];
  let ok = true;
  try { op.apply(src, Object.assign(IL.defaultParams(op), { low: 200, high: 10 })); } catch (e) { ok = false; }
  check('canny がしきい値の逆転を許容', ok);
}

/* Sobel の各表示 */
{
  const op = IL.opById['sobel'];
  for (const s of ['mag', 'gx', 'gy', 'dir']) {
    let ok = true;
    try { op.apply(src, Object.assign(IL.defaultParams(op), { show: s })); } catch (e) { ok = false; console.log(e.stack); }
    check('sobel 表示 ' + s, ok);
  }
}

/* Laplacian の各表示・各カーネル */
{
  const op = IL.opById['laplacian'];
  for (const k of ['k4', 'k8', 'log']) {
    for (const s of ['signed', 'abs', 'zero']) {
      let ok = true;
      try { op.apply(src, Object.assign(IL.defaultParams(op), { kind: k, show: s })); } catch (e) { ok = false; console.log(e.stack); }
      check('laplacian ' + k + '/' + s, ok);
    }
  }
}

/* CLAHE：タイル数とクリップの端の値でも落ちない */
{
  const op = IL.opById['clahe'];
  for (const t of [2, 8, 16]) {
    for (const c of [1, 10]) {
      let ok = true;
      try { op.apply(src, Object.assign(IL.defaultParams(op), { tiles: t, clip: c })); } catch (e) { ok = false; console.log(e.stack); }
      check('clahe tiles=' + t + ' clip=' + c, ok);
    }
  }
}

/* ヒストグラム平坦化でダイナミックレンジが広がる */
{
  const w = 64, h = 64, img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {          /* 100〜140 に押し込めた画像 */
    const v = 100 + (i % 40);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  const op = IL.opById['histeq'];
  const out = op.apply(img, IL.defaultParams(op));
  let lo = 255, hi = 0;
  for (let i = 0; i < out.data.length; i += 4) { lo = Math.min(lo, out.data[i]); hi = Math.max(hi, out.data[i]); }
  check('histeq がレンジを広げる', hi - lo > 200, lo + '..' + hi);
}

/* バイラテラルは段差を保つ */
{
  const w = 64, h = 64, img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = x < w / 2 ? 60 : 200;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  const opB = IL.opById['bilateral'];
  const outB = opB.apply(img, Object.assign(IL.defaultParams(opB), { sigmaS: 3, sigmaC: 20 }));
  const opG = IL.opById['blur'];
  const outG = opG.apply(img, Object.assign(IL.defaultParams(opG), { kind: 'gauss', sigma: 3 }));
  const mid = (32 * w + 32) * 4;             /* 段差の1つ右の画素 */
  const stepB = Math.abs(outB.data[mid] - outB.data[mid - 4]);
  const stepG = Math.abs(outG.data[mid] - outG.data[mid - 4]);
  check('バイラテラルはガウシアンより段差を残す', stepB > stepG * 1.5, 'bilateral ' + stepB + ' / gauss ' + stepG);
}

/* --- 3-2. FFT の中身 ---
 *
 * 外部ライブラリを使わない自前実装なので、まず「定義どおりの DFT と一致するか」を
 * 直接確かめる。ここが合っていないと、この先の周波数フィルタの見え方が
 * すべて「それらしいが違うもの」になる。 */
console.log('3-2) FFT の中身');
{
  const U = IL.util;

  /* 定義どおりの離散フーリエ変換（O(N²)。遅いが疑いようがない） */
  function naiveDFT(re, im) {
    const n = re.length, R = new Float64Array(n), I = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      for (let t = 0; t < n; t++) {
        const a = -2 * Math.PI * k * t / n, c = Math.cos(a), s = Math.sin(a);
        R[k] += re[t] * c - im[t] * s;
        I[k] += re[t] * s + im[t] * c;
      }
    }
    return [R, I];
  }

  for (const n of [2, 8, 16, 64]) {
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 1.3) * 50 + i; im[i] = Math.cos(i * 0.7) * 10; }
    const [R, I] = naiveDFT(Array.from(re), Array.from(im));
    U.fft1d(re, im, 0, 1, U.fftPlan(n), false);
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(re[i] - R[i]), Math.abs(im[i] - I[i]));
    check('fft1d が定義どおりの DFT と一致（n=' + n + '）', m < 1e-3, '最大差 ' + m.toExponential(2));
  }

  /* 順変換 → 逆変換で元に戻るか（2次元、非正方） */
  {
    const W = 32, H = 16, n = W * H;
    const re = new Float32Array(n), im = new Float32Array(n), r0 = new Float32Array(n);
    for (let i = 0; i < n; i++) { re[i] = r0[i] = (i * 37 % 251) - 125; }
    const pw = U.fftPlan(W), ph = U.fftPlan(H);
    U.fft2d(re, im, W, H, pw, ph, false);
    U.fft2d(re, im, W, H, pw, ph, true);
    let m = 0, mi = 0;
    for (let i = 0; i < n; i++) { m = Math.max(m, Math.abs(re[i] - r0[i])); mi = Math.max(mi, Math.abs(im[i])); }
    check('fft2d が往復して元に戻る', m < 1e-2, '最大差 ' + m.toExponential(2));
    check('実数入力の往復で虚部が残らない', mi < 1e-2, '最大 ' + mi.toExponential(2));
  }

  /* 単一の正弦波を入れたら、その周波数のビンだけが立つか。
     周波数 u₀ = 4/W の縞なら、ビン 4 と W−4 の2本だけに集まるはず */
  {
    const W = 64, H = 32, n = W * H, u0 = 4;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) re[y * W + x] = Math.cos(2 * Math.PI * u0 * x / W);
    }
    U.fft2d(re, im, W, H, U.fftPlan(W), U.fftPlan(H), false);
    const mag = (kx, ky) => Math.hypot(re[ky * W + kx], im[ky * W + kx]);
    let peak = 0, other = 0;
    for (let ky = 0; ky < H; ky++) {
      for (let kx = 0; kx < W; kx++) {
        const v = mag(kx, ky);
        if (ky === 0 && (kx === u0 || kx === W - u0)) peak = Math.max(peak, v);
        else other = Math.max(other, v);
      }
    }
    check('正弦波が正しいビンに立つ', peak > 100 * (other + 1e-9),
          'ピーク ' + peak.toFixed(1) + ' / それ以外 ' + other.toExponential(2));
  }

  /* 手描きマスクの格子番号が DC を中心に左右対称か。
   *
   * ここが半セルでもずれると、共役対称（F(−u,−v) = conj F(u,v)）が崩れて
   * 逆変換の結果に虚部が残る。目に見える壊れ方をしないまま結果だけ濁るので、
   * ブラウザで気づきにくい。数値で押さえておく。 */
  for (const [n, G] of [[1024, 128], [512, 128], [128, 128], [256, 64]]) {
    let ok = true, bad = '';
    for (let k = 0; k < n; k++) {
      const kc = (n - k) % n;                       /* 共役の相手のビン */
      const g = U.fftGridIndex((k + (n >> 1)) % n, n, G);
      const gc = U.fftGridIndex((kc + (n >> 1)) % n, n, G);
      if (gc !== (G - g) % G) { ok = false; bad = 'k=' + k + ' → ' + g + ' / ' + gc; break; }
    }
    check('fftGridIndex が点対称（n=' + n + ', G=' + G + '）', ok, bad);
  }
  check('fftGridIndex の DC が格子の中央', IL.util.fftGridIndex(512, 1024, 128) === 64);

  /* ノッチが縞だけを落とせるか。
     一定値の下地に振幅 30 の斜め縞を乗せ、その周波数を潰して平坦に戻るかを見る。
     画像を 128×128（2の冪そのもの）にしてあるのは、縞がビンにちょうど乗るようにするため。
     半端なサイズだと2の冪へ広げるときに周期が崩れ、成分が隣のビンへ漏れて
     （スペクトル漏れ）落としきれない。ノッチの実装ではなく標本化の話なので、
     ここでは切り分けて見ている */
  {
    const w = 128, h = 128, u0 = 0.1875, v0 = 0.125;   /* 24/128 と 16/128 */
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = 128 + 30 * Math.sin(2 * Math.PI * (u0 * x + v0 * y)), i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    const op = IL.opById['fftfilter'];
    const p = Object.assign(IL.defaultParams(op), {
      kind: 'notch', shape: 'gauss', nu: u0, nv: v0, nr: 0.02, channels: 'luma', edge: 'reflect'
    });
    const out = op.apply(img, p);
    let lo = 255, hi = 0;
    for (let y = 8; y < h - 8; y++) {                /* 縁は鏡映の影響が残るので内側で見る */
      for (let x = 8; x < w - 8; x++) {
        const v = out.data[(y * w + x) * 4];
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
    }
    check('ノッチが周期ノイズを落とす', hi - lo <= 2, '残った振れ幅 ' + (hi - lo) + '（元は 60）');
  }

  /* --- 輝点さがし（右パネルの「ここ」の印） ---
   *
   * 印が違う場所を指したら、案内が無いより悪い。指し先を数値で押さえる。 */
  {
    const w = 128, h = 96;
    const u0 = 0.18, v0 = 0.09;

    /* なだらかな下地に、周期 (u0, v0) の縞を1本だけ乗せる */
    const striped = new ImageData(w, h);
    const plain = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const base = 60 + 120 * (x / w) + 40 * (y / h);
        const s = base + 30 * Math.cos(2 * Math.PI * (u0 * x + v0 * y));
        plain.data[o] = plain.data[o + 1] = plain.data[o + 2] = base;
        striped.data[o] = striped.data[o + 1] = striped.data[o + 2] = s;
        plain.data[o + 3] = striped.data[o + 3] = 255;
      }
    }

    const pk = IL.spectrumPeaks(striped, 'reflect');
    check('周期ノイズの輝点を見つける', pk.length >= 2, pk.length + ' 個');
    if (pk.length) {
      /* いちばん強い輝点が、縞の周波数（の符号違いを含む）を指しているか */
      const du = Math.abs(Math.abs(pk[0].u) - u0), dv = Math.abs(Math.abs(pk[0].v) - v0);
      check('輝点の位置が縞の周波数と一致', du < 0.012 && dv < 0.012,
            'u ' + pk[0].u.toFixed(3) + ' / v ' + pk[0].v.toFixed(3) +
            '（縞は ' + u0 + ' / ' + v0 + '）');
      /* 点対称の相方も見つかること。片方だけ塗ると絵が濁るので、両方に印が要る */
      const mate = pk.some((q) => Math.abs(q.u + pk[0].u) < 0.012 && Math.abs(q.v + pk[0].v) < 0.012);
      check('点対称の相方も見つかる', mate);
    }

    /* 縞の無い画像に印を出さない（自然写真で誤った案内をしないこと） */
    check('突出が無ければ印は出ない', IL.spectrumPeaks(plain, 'reflect').length === 0,
          IL.spectrumPeaks(plain, 'reflect').length + ' 個');
  }
}

/* --- 3-3. ノイズと評価の中身 ---
 *
 * ノイズは「乗せてみたら、それらしく見える」で済ませられない。
 * 位置ハッシュで作っているので分布が崩れていても絵は自然に見えてしまうし、
 * PSNR / SSIM は桁が合っていないと気づけない。数値で押さえる。 */
console.log('3-3) ノイズと評価の中身');
{
  const U = IL.util;
  const w = 128, h = 96, n = w * h;

  /* 一様な灰色。ノイズの分布そのものを測るための台 */
  function flat(v) {
    const img = new ImageData(w, h);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
    }
    return img;
  }

  /* --- ガウシアンノイズ：標準偏差が指定どおりか --- */
  {
    const base = flat(128);
    const out = U.noiseBand(base, { kind: 'gauss', sigma: 20, seed: 1, color: false }, 0, h);
    let sum = 0, sq = 0;
    for (let i = 0; i < n; i++) { const e = out.data[i * 4] - 128; sum += e; sq += e * e; }
    const mean = sum / n, sd = Math.sqrt(sq / n - mean * mean);
    check('ガウシアンノイズの平均がほぼ 0', Math.abs(mean) < 1.0, 'mean ' + mean.toFixed(2));
    check('ガウシアンノイズの σ が指定どおり', Math.abs(sd - 20) < 1.5, 'σ ' + sd.toFixed(2));
  }

  /* --- 色を切ったときは3チャンネルに同じ値が乗る --- */
  {
    const out = U.noiseBand(flat(128), { kind: 'gauss', sigma: 25, seed: 3, color: false }, 0, h);
    let same = true;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      if (out.data[j] !== out.data[j + 1] || out.data[j] !== out.data[j + 2]) same = false;
    }
    check('色を切ったノイズは3チャンネル同じ', same);

    const outC = U.noiseBand(flat(128), { kind: 'gauss', sigma: 25, seed: 3, color: true }, 0, h);
    let differ = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      if (outC.data[j] !== outC.data[j + 1]) differ++;
    }
    check('色を入れたノイズはチャンネルごとに違う', differ > n * 0.8, differ + ' / ' + n);
  }

  /* --- ソルト＆ペッパー：飛ぶ割合と、飛んでいない画素の無傷さ --- */
  {
    const base = flat(128);
    const out = U.noiseBand(base, { kind: 'sp', prob: 0.1, seed: 5, color: false }, 0, h);
    let hit = 0, intact = true, black = 0, white = 0;
    for (let i = 0; i < n; i++) {
      const v = out.data[i * 4];
      if (v === 0) { hit++; black++; }
      else if (v === 255) { hit++; white++; }
      else if (v !== 128) intact = false;
    }
    check('ソルト＆ペッパーの割合が指定どおり', Math.abs(hit / n - 0.1) < 0.02, (hit / n).toFixed(3));
    check('飛んでいない画素は原画のまま', intact);
    check('白と黒がほぼ半々', Math.abs(black - white) < n * 0.03, black + ' / ' + white);
  }

  /* --- ショットノイズ：暗いところほど相対的に荒れる（信号依存） --- */
  {
    const dark = U.noiseBand(flat(20), { kind: 'shot', peak: 20, seed: 7, color: false }, 0, h);
    const bright = U.noiseBand(flat(200), { kind: 'shot', peak: 20, seed: 7, color: false }, 0, h);
    const rel = (out, v) => {
      let sq = 0;
      for (let i = 0; i < n; i++) { const e = out.data[i * 4] - v; sq += e * e; }
      return Math.sqrt(sq / n) / v;
    };
    const rd = rel(dark, 20), rb = rel(bright, 200);
    check('ショットノイズは暗部のほうが相対的に荒れる', rd > rb * 1.5,
          '暗部 ' + rd.toFixed(3) + ' / 明部 ' + rb.toFixed(3));
  }

  /* --- 周期ノイズ：スペクトルの狙った1点に立ち、塗れば絵を壊さずに取れる ---
   *
   * これは「同好会で見せる山場」そのものなので、教材の主張が崩れたら落ちるようにしておく。
   * 実写の網戸や印刷物ではノイズの成分が帯に散ってしまい、輝点を塗っても取れない
   * （2026-09-09 に実測。網の帯の 6.5% しか落ちなかった）。合成の縞ならそうならない、
   * というのがこの op を足した理由なので、そこを数値で押さえる。 */
  {
    /* 台。3つとも意図がある。
       ・階調と四角 … 絵が壊れたかどうかを読み取るため
       ・値を 70〜170 に収める … 振幅30の縞を足しても 0/255 で頭打ちにならないため。
         頭打ちすると高調波が生まれてスペクトルに散り、輝点1点では取れなくなる
       ・下半分の細い横線（4画素ごと） … ぼかしとの差を出すため。
         斜めの縞とは向きが違うので、マスクでは無傷、ぼかしでは真っ先に壊れる */
    function scene() {
      const img = new ImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        let v = 70 + 100 * (x / w);
        if (x > w * 0.3 && x < w * 0.6 && y > h * 0.3 && y < h * 0.7) v = 75;
        if (y > h * 0.75) v = 125 + ((y % 4) < 2 ? 25 : -25);
        img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
      }
      return img;
    }

    /* FFT の格子（128×96 → 128×128）でちょうどビンに乗る縞にしておく。
       半端な周波数だと漏れが出て、ビンの一致を厳しく見られない */
    const W = U.nextPow2(w), H2 = U.nextPow2(h);
    const bu = 24, bv = 12;
    const u0 = bu / W, v0 = bv / H2;
    const pp = { kind: 'periodic', pperiod: 1 / Math.hypot(u0, v0),
      pangle: Math.atan2(v0, u0) * 180 / Math.PI, pamp: 30, seed: 1, color: false };

    /* 1. 振幅どおりに振れているか（灰色の台なら 128 ± 30） */
    {
      const out = U.noiseBand(flat(128), pp, 0, h);
      let lo = 255, hi = 0, sum = 0;
      for (let i = 0; i < n; i++) { const v = out.data[i * 4]; if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
      check('周期ノイズの振れ幅が「縞の濃さ」どおり', hi - lo >= 56 && hi - lo <= 60, (hi - lo) + ' 階調');
      check('周期ノイズは平均を動かさない', Math.abs(sum / n - 128) < 1.0, (sum / n).toFixed(2));
    }

    /* 2. 乱数を使っていない＝種を変えても1バイトも変わらない */
    {
      const a = U.noiseBand(flat(128), pp, 0, h);
      const b = U.noiseBand(flat(128), Object.assign({}, pp, { seed: 9 }), 0, h);
      check('周期ノイズは種で変わらない（乱数を使っていない）', maxAbsDiff(a, b) === 0);
    }

    /* 3. スペクトルの狙ったビンに立つか。DC と縁の十字を除いた最大を探す */
    {
      const noisy = U.noiseBand(flat(128), pp, 0, h);
      const ctx = U.fftAnalyze(noisy, true, 'reflect');
      const re = ctx.re[0], im = ctx.im[0];
      let best = -1, bx = 0, by = 0;
      for (let ky = 0; ky < H2; ky++) {
        const fy = (ky < H2 / 2) ? ky : ky - H2;
        if (Math.abs(fy) <= 1) continue;
        for (let kx = 0; kx < W; kx++) {
          const fx = (kx < W / 2) ? kx : kx - W;
          if (Math.abs(fx) <= 1) continue;
          const i = ky * W + kx, p2 = re[i] * re[i] + im[i] * im[i];
          if (p2 > best) { best = p2; bx = fx; by = fy; }
        }
      }
      check('周期ノイズが狙ったビンに立つ', Math.abs(Math.abs(bx) - bu) === 0 && Math.abs(Math.abs(by) - bv) === 0,
            '(' + bx + ', ' + by + ') 期待 ±(' + bu + ', ' + bv + ')');
    }

    /* 4. 輝点さがしが見つけるか。これが出ないと実演が成立しない */
    {
      const noisy = U.noiseBand(scene(), pp, 0, h);
      const peaks = IL.spectrumPeaks(noisy, 'reflect');
      const hit = peaks.some(pk => Math.abs(Math.abs(pk.u) - u0) < 0.01 && Math.abs(Math.abs(pk.v) - v0) < 0.01);
      check('輝点さがしが周期ノイズを見つける', hit, peaks.length + ' 個');
      check('点対称の相方も出る', peaks.length >= 2, peaks.length + ' 個');
    }

    /* 4-b. 台が飽和すると「倍音」が生まれ、印が基本波の2倍の位置にも出る。
     *
     * 2026-09-10、チェックリストの項目45 を `geometry`（背景242・図形28）で書いてしまい、
     * 画面の 31.7% が 255 で頭打ちになって印が6個出た。サインの山が刈り取られて
     * 波形が歪むため。塗っても 33.9 dB までしか戻らない（飽和で消えた情報は戻らない）。
     * 教材としては面白いので、挙動として固定しておく。 */
    {
      const bright = new ImageData(w, h);
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        /* 白い紙（242）に黒い図形。振幅30を足すと背景が 255 で頭打ちになる */
        const v = (i % w > w * 0.2 && i % w < w * 0.4) ? 28 : 242;
        bright.data[j] = bright.data[j + 1] = bright.data[j + 2] = v; bright.data[j + 3] = 255;
      }
      const noisy = U.noiseBand(bright, pp, 0, h);
      let clipped = 0;
      for (let i = 0; i < n; i++) { const v = noisy.data[i * 4]; if (v === 0 || v === 255) clipped++; }
      check('明るい台では縞が飽和する', clipped > n * 0.2, (clipped / n * 100).toFixed(1) + ' %');

      const r0 = Math.hypot(u0, v0);
      const harm = IL.spectrumPeaks(noisy, 'reflect')
        .some(pk => Math.abs(Math.hypot(pk.u, pk.v) / r0 - 2) < 0.15);
      check('飽和すると基本波の2倍の位置にも輝点が出る（倍音）', harm);
    }

    /* 5. 縦縞（0°）は十字の上に乗るので見つからない。解説文で言っている主張の裏取り */
    {
      const vert = U.noiseBand(scene(), Object.assign({}, pp, { pangle: 0, pperiod: 5 }), 0, h);
      const peaks = IL.spectrumPeaks(vert, 'reflect');
      const onAxis = peaks.some(pk => Math.abs(pk.v) < 0.01);
      check('縦縞は輝点として拾われない（十字の上）', !onAxis, peaks.length + ' 個');
    }

    /* 6. 塗れば取れる。しかも絵は壊れない ← 実演そのもの */
    {
      const base = scene();
      const noisy = U.noiseBand(base, pp, 0, h);
      const before = U.psnr(base, noisy);

      /* 筆は輝点の上に半径2格子（＝UI の「筆の太さ 4」相当）。
         ぼかしは 0。小さな印にぼかしを掛けると谷が浅くなり、縞が半分しか落ちない
         （UI の既定 2 は、広い範囲を塗るとき用）。 */
      const G = IL.MASK_GRID;
      const mask = new Uint8Array(G * G); mask.fill(255);
      for (const s of [1, -1]) {
        const gu = s * u0 * G + G / 2, gv = s * v0 * G + G / 2;
        for (let gy = Math.round(gv) - 3; gy <= Math.round(gv) + 3; gy++)
          for (let gx = Math.round(gu) - 3; gx <= Math.round(gu) + 3; gx++) {
            if (gx < 0 || gy < 0 || gx >= G || gy >= G) continue;
            if (Math.hypot(gx + 0.5 - gu, gy + 0.5 - gv) <= 2) mask[gy * G + gx] = 0;
          }
      }
      const cleaned = IL.opById['fftmask'].apply(noisy,
        { mask: mask, soft: 0, invert: false, channels: 'rgb', edge: 'reflect', show: 'image' });
      const after = U.psnr(base, cleaned);
      check('輝点を塗ると縞が取れる（PSNR が大きく上がる）', after > before + 10,
            before.toFixed(1) + ' dB → ' + after.toFixed(1) + ' dB');

      /* ぼかしでは同じことができない、という対照。縞が消えるまでぼかすと絵も消える */
      const blurred = IL.opById['blur'].apply(noisy, { kind: 'gauss', sigma: 2.5, radius: 3 });
      check('ぼかしでは周期ノイズを絵ごと壊さずに取れない', U.psnr(base, blurred) < after - 5,
            'ぼかし ' + U.psnr(base, blurred).toFixed(1) + ' dB / マスク ' + after.toFixed(1) + ' dB');
    }
  }

  /* --- 位置ハッシュ：同じ種なら何度やっても同じ、違う種なら変わる --- */
  {
    const p = { kind: 'gauss', sigma: 20, seed: 2, color: false };
    const a1 = U.noiseBand(src, p, 0, H), a2 = U.noiseBand(src, p, 0, H);
    const b = U.noiseBand(src, Object.assign({}, p, { seed: 3 }), 0, H);
    check('同じ種なら同じノイズ', maxAbsDiff(a1, a2) === 0);
    check('種を変えると変わる', maxAbsDiff(a1, b) > 10);
  }

  /* --- PSNR：理論値と突き合わせる --- */
  {
    const a = flat(100);
    check('同一画像の PSNR は無限大', U.psnr(a, a) === Infinity);

    /* 全画素を一律 +10 ずらすと MSE = 100 → PSNR = 10·log10(65025/100) */
    const b = flat(110);
    const want = 10 * Math.log10(255 * 255 / 100);
    check('一定差の PSNR が理論値と一致', Math.abs(U.psnr(a, b) - want) < 1e-6,
          U.psnr(a, b).toFixed(4) + ' / ' + want.toFixed(4));
  }

  /* --- SSIM：性質を押さえる --- */
  {
    const clean = testImage(w, h);
    const noisy = U.noiseBand(clean, { kind: 'gauss', sigma: 25, seed: 1, color: false }, 0, h);
    const s11 = U.ssim(clean, clean);
    check('同一画像の SSIM が 1', Math.abs(s11 - 1) < 1e-6, s11.toFixed(6));
    check('SSIM は 0〜1 に収まる', U.ssim(clean, noisy) > 0 && U.ssim(clean, noisy) < 1);
    check('ノイズを乗せると SSIM が落ちる', U.ssim(clean, noisy) < 0.9, U.ssim(clean, noisy).toFixed(3));
    check('SSIM は入れ替えても同じ', Math.abs(U.ssim(clean, noisy) - U.ssim(noisy, clean)) < 1e-9);

    /* 基準側を使い回す経路が、素直に計算した値と一致するか
       （比較 op はこちらを使うので、ここがずれると数値だけが静かに狂う） */
    const ref = U.ssimRef(clean);
    check('ssimRef 経由でも同じ値', Math.abs(U.ssimAgainst(ref, noisy) - U.ssim(clean, noisy)) < 1e-9);
  }

  /* --- タイル合成 --- */
  {
    const q = [flat(10), flat(70), flat(130), flat(200)];
    const half = q.map((x) => U.halveImage(x));
    check('halveImage が半分の大きさになる', half[0].width === w / 2 && half[0].height === h / 2);
    check('halveImage は一様な面の値を変えない', half[0].data[0] === 10);

    const t = U.tile2x2(half, w, h);
    check('tile2x2 の大きさが元と同じ', t.width === w && t.height === h);
    const at = (x, y) => t.data[(y * w + x) * 4];
    check('タイルの左上が1枚目', at(2, 2) === 10);
    check('タイルの右上が2枚目', at(w - 3, 2) === 70);
    check('タイルの左下が3枚目', at(2, h - 3) === 130);
    check('タイルの右下が4枚目', at(w - 3, h - 3) === 200);
  }

  /* --- 比較 op が返す数値 ---
   *
   * 「ソルト＆ペッパーにはメディアンが圧勝し、ガウシアンノイズでは順位が変わる」
   * というのがこの処理で見せたい中身そのものなので、そこをテストで押さえる。 */
  {
    const op = IL.opById['denoisecmp'];
    const clean = testImage(w, h);

    const runCmp = (over) => {
      const p = Object.assign(IL.defaultParams(op), over);
      const sink = {};
      const out = op.apply(clean, p, sink);
      return { out, rep: sink.report, p };
    };

    const sp = runCmp({ kind: 'sp', prob: 0.06, view: 'tile' });
    check('比較 op が report を返す', !!(sp.rep && sp.rep.rows));
    check('report の行が5本（見出し＋4手法）', sp.rep && sp.rep.rows.length === 5,
          sp.rep && String(sp.rep.rows.length));
    check('4分割のときタイルが4面', sp.rep && sp.rep.tiles && sp.rep.tiles.length === 4);
    check('タイルの位置が 2×2 に並ぶ', sp.rep && sp.rep.tiles[3].x === (w >> 1) &&
          sp.rep.tiles[3].y === (h >> 1));
    /* ★は PSNR の列と SSIM の列に1つずつ。同じ手法に2つ付くことも、
       別々の手法に分かれることもある（分かれるのがこの処理の見どころ） */
    {
      const body = sp.rep ? sp.rep.rows.slice(1) : [];
      const stars = body.join('|').split('★').length - 1;
      check('★がちょうど2つ（PSNR に1つ・SSIM に1つ）', stars === 2, stars + ' 個');
      const pstar = body.filter((r) => /^★/.test(r[1])).length;
      const sstar = body.filter((r) => /\/ ★/.test(r[1])).length;
      check('★が列ごとに1つずつ', pstar === 1 && sstar === 1,
            'PSNR ' + pstar + ' / SSIM ' + sstar);
      /* ノイズあり（1行目）に★が付いたら、除去が全部それ以下ということ。おかしい */
      check('★はノイズあり以外に付く', !/★/.test(body[0][1]), body[0][1]);
    }
    check('4分割の出力サイズが入力と同じ', sp.out.width === w && sp.out.height === h);

    /* 単体表示ではタイルを出さない（見出しが二重に乗らないように） */
    const single = runCmp({ kind: 'sp', view: 'median' });
    check('単体表示ではタイルを返さない', single.rep && !single.rep.tiles);

    /* 数値そのものを取り直して順位を見る */
    const scores = (over) => {
      const p = Object.assign(IL.defaultParams(op), over);
      const noisy = U.noiseBand(clean, { kind: p.kind, sigma: p.sigma, prob: p.prob,
                                         peak: p.peak, seed: p.seed, color: p.color }, 0, h);
      const mp = { radius: p.mradius, iter: 1 };
      const bp = { sigmaS: p.bsigmaS, sigmaC: p.bsigmaC, metric: 'luma' };
      const gp = { kind: 'gauss', sigma: p.gsigma };
      const med = U.opKernel('median')(noisy, mp, 0, h, U.opPrepare('median')(noisy, mp));
      const bil = U.opKernel('bilateral')(noisy, bp, 0, h, U.opPrepare('bilateral')(noisy, bp));
      const gau = U.opKernel('blur')(noisy, gp, 0, h, U.opPrepare('blur')(noisy, gp));
      return { noisy: U.psnr(clean, noisy), med: U.psnr(clean, med),
               bil: U.psnr(clean, bil), gau: U.psnr(clean, gau) };
    };

    const a = scores({ kind: 'sp', prob: 0.06 });
    check('ソルト＆ペッパーではメディアンが最良', a.med > a.bil && a.med > a.gau,
          JSON.stringify(a, (k, v) => typeof v === 'number' ? +v.toFixed(1) : v));
    check('ソルト＆ペッパーはメディアンで大きく改善', a.med > a.noisy + 5,
          a.noisy.toFixed(1) + ' → ' + a.med.toFixed(1));

    const g = scores({ kind: 'gauss', sigma: 25 });
    check('ガウシアンノイズではメディアンが最良ではない', !(g.med > g.bil && g.med > g.gau),
          JSON.stringify(g, (k, v) => typeof v === 'number' ? +v.toFixed(1) : v));
    check('ガウシアンノイズもどれかで改善する',
          Math.max(g.med, g.bil, g.gau) > g.noisy + 2,
          g.noisy.toFixed(1) + ' → ' + Math.max(g.med, g.bil, g.gau).toFixed(1));

    /* U.opKernel が別の処理をちゃんと呼べているか（ページ側の実装） */
    const opMed = IL.opById['median'];
    const mp = { radius: 1, iter: 1 };
    const direct = opMed.kernel(clean, mp, 0, h, opMed.prepare(clean, mp));
    const viaU = U.opKernel('median')(clean, mp, 0, h, U.opPrepare('median')(clean, mp));
    check('U.opKernel が同じ処理を呼んでいる', maxAbsDiff(direct, viaU) === 0);
    let threw = false;
    try { U.opKernel('そんな処理は無い'); } catch (e) { threw = true; }
    check('知らない処理を呼ぶと落ちる', threw);
  }
}

/* --- 3-4. 二値化の中身 --- */
console.log('3-4) 二値化の中身');
{
  const U = IL.util;
  const op = IL.opById['threshold'];
  const w = 96, h = 72, n = w * h;

  const run = (img, over) => {
    const p = Object.assign(IL.defaultParams(op), over);
    const sink = {};
    const out = op.apply(img, p, sink);
    return { out, rows: sink.report ? sink.report.rows : null, p };
  };
  const rowVal = (rows, label) => {
    const r = rows.filter((x) => x[0] === label)[0];
    return r ? r[1] : null;
  };
  /* 出力に出てくる値の種類（0 と 255 しかないはず） */
  const levels = (img) => {
    const set = new Set();
    for (let i = 0; i < img.data.length; i += 4) set.add(img.data[i]);
    return [...set].sort((a, b) => a - b);
  };
  const whiteRatio = (img) => {
    let c = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 255) c++;
    return c / (img.width * img.height);
  };

  /* 山が2つだけの絵。60 と 200 が半々。大津は必ずその間を選ぶ */
  const bimodal = (() => {
    const img = new ImageData(w, h), d = img.data;
    for (let y = 0, j = 0; y < h; y++) {
      for (let x = 0; x < w; x++, j += 4) {
        const v = (x < w / 2) ? 60 : 200;
        d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
      }
    }
    return img;
  })();

  {
    const a = run(bimodal, { method: 'otsu' });
    check('二値化の出力は 0 と 255 だけ', String(levels(a.out)) === '0,255', String(levels(a.out)));
    const t = parseInt(rowVal(a.rows, '閾値'), 10);
    check('大津の閾値が2つの山の間に入る', t >= 60 && t < 200, String(t));
    check('大津の分離度が 1 に近い', parseFloat(rowVal(a.rows, '分離度 η')) > 0.99,
          rowVal(a.rows, '分離度 η'));
    check('山が半々なら白も半分', Math.abs(whiteRatio(a.out) - 0.5) < 0.01,
          whiteRatio(a.out).toFixed(3));
  }

  /* 大津は「クラス間分散が最大になる閾値」。
     ここでは op の中の漸化式に頼らず、素朴に総当たりした答えと突き合わせる
     （report の η は3桁に丸めてあり、丸めると同値が並ぶので使えない） */
  {
    const a = run(src, { method: 'otsu' });
    const otsuT = parseInt(rowVal(a.rows, '閾値'), 10);

    const hist = U.histogram256(U.toGrayPlane(src));
    const total = src.width * src.height;
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * hist[i];
    const between = (t) => {
      let w0 = 0, s0 = 0;
      for (let k = 0; k <= t; k++) { w0 += hist[k]; s0 += k * hist[k]; }
      const w1 = total - w0;
      if (w0 === 0 || w1 === 0) return -1;
      const m0 = s0 / w0, m1 = (sumAll - s0) / w1;
      return (w0 / total) * (w1 / total) * (m0 - m1) * (m0 - m1);
    };
    let bestT = -1, bestB = -1;
    for (let t = 0; t < 256; t++) { const b = between(t); if (b > bestB) { bestB = b; bestT = t; } }
    check('大津の閾値が総当たりの最大と一致', otsuT === bestT, otsuT + ' 対 ' + bestT);
    check('大津より良い閾値は無い', between(otsuT) >= bestB - 1e-12);

    /* 同じ閾値なら、固定でも大津でも絵は同じ */
    const b = run(src, { method: 'fixed', thr: otsuT });
    check('同じ閾値なら固定と大津の絵が一致', maxAbsDiff(a.out, b.out) === 0);
    /* report の η も、素朴に出した値と合っているか */
    let varAll = 0;
    const mean = sumAll / total;
    for (let i = 0; i < 256; i++) varAll += hist[i] * (i - mean) * (i - mean);
    varAll /= total;
    check('report の分離度 η が計算と合う',
          Math.abs(parseFloat(rowVal(a.rows, '分離度 η')) - bestB / varAll) < 5e-4,
          rowVal(a.rows, '分離度 η') + ' 対 ' + (bestB / varAll).toFixed(3));
  }

  /* 白黒の入れ替えは、そのまま反転になる */
  {
    const a = run(src, { method: 'otsu' });
    const b = run(src, { method: 'otsu', invert: true });
    let ok = true;
    for (let i = 0; i < a.out.data.length; i += 4) {
      if (a.out.data[i] + b.out.data[i] !== 255) { ok = false; break; }
    }
    check('白黒の入れ替えがちょうど反転になる', ok);
    check('入れ替えると白の割合も裏返る',
          Math.abs(whiteRatio(a.out) + whiteRatio(b.out) - 1) < 1e-9);
  }

  /* 閾値を上げるほど白は減る（単調） */
  {
    let prev = 1.1, mono = true;
    for (const t of [0, 32, 64, 96, 128, 160, 192, 224, 255]) {
      const r = whiteRatio(run(src, { method: 'fixed', thr: t }).out);
      if (r > prev + 1e-12) { mono = false; break; }
      prev = r;
    }
    check('閾値を上げると白は増えない', mono);
  }

  /* 積分画像で出した窓の平均が、素朴に足した平均と一致するか。
     ここが狂うと適応的の結果が丸ごとずれるので、値そのものを突き合わせる */
  {
    const r = 5;
    const p = Object.assign(IL.defaultParams(op),
                            { method: 'adaptive', radius: r, bias: 0, stat: 'mean' });
    const c = op.prepare(src, p);
    const g = U.toGrayPlane(src);
    let worst = 0;
    for (const [x, y] of [[0, 0], [w - 1, h - 1], [3, 2], [w - 2, 40], [48, 36], [1, h - 1]]) {
      let s = 0, cnt = 0;
      for (let yy = Math.max(0, y - r); yy < Math.min(h, y + r + 1); yy++) {
        for (let xx = Math.max(0, x - r); xx < Math.min(w, x + r + 1); xx++) {
          s += g[yy * w + xx]; cnt++;
        }
      }
      worst = Math.max(worst, Math.abs(c.mp[y * w + x] - s / cnt));
    }
    check('積分画像の窓平均が素朴な平均と一致', worst < 1e-3, '最大差 ' + worst.toExponential(1));
  }

  /* 適応的は「傾いた下地」に強い。大域の閾値だと潰れる絵で差が出ること */
  {
    /* 左上ほど暗い下地に、一定の振幅の細かい模様を乗せる。
       1枚に1つの閾値では、明るい側が全部白・暗い側が全部黒に倒れる */
    const tilt = new ImageData(w, h), d = tilt.data;
    for (let y = 0, j = 0; y < h; y++) {
      for (let x = 0; x < w; x++, j += 4) {
        const base = 30 + 190 * ((x / w) * 0.5 + (y / h) * 0.5);
        const det = ((x >> 2) + (y >> 2)) % 2 ? 12 : -12;
        const v = Math.max(0, Math.min(255, base + det));
        d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
      }
    }
    /* 模様は市松なので、正しく拾えていれば白はおよそ半分になる */
    const glob = whiteRatio(run(tilt, { method: 'otsu' }).out);
    const adap = whiteRatio(run(tilt, { method: 'adaptive', radius: 6, bias: 0, stat: 'mean' }).out);
    check('傾いた下地では適応的のほうが半々に近い',
          Math.abs(adap - 0.5) < Math.abs(glob - 0.5),
          '大域 ' + glob.toFixed(3) + ' / 適応的 ' + adap.toFixed(3));
    check('適応的が細かい模様を拾えている', Math.abs(adap - 0.5) < 0.06, adap.toFixed(3));
  }

  /* 窓の大きさを変えても処理時間がほとんど変わらない（積分画像の効き目）。
     時間そのものは環境で揺れるので、桁が変わらないことだけを見る */
  {
    const t = (r) => {
      const p = Object.assign(IL.defaultParams(op),
                              { method: 'adaptive', radius: r, stat: 'mean' });
      const big = new ImageData(320, 240);
      for (let i = 0; i < big.data.length; i += 4) {
        big.data[i] = big.data[i + 1] = big.data[i + 2] = (i * 7) & 255;
        big.data[i + 3] = 255;
      }
      const t0 = Date.now();
      op.apply(big, p);
      return Date.now() - t0;
    };
    const small = t(3), large = t(60);
    check('窓を広げても処理時間が跳ね上がらない', large <= Math.max(20, small * 4 + 8),
          '半径3 で ' + small + ' ms、半径60 で ' + large + ' ms');
  }

  /* report の形（右下に出す行） */
  {
    const a = run(src, { method: 'otsu' });
    check('二値化が report を返す', !!a.rows);
    check('report の行が5本', a.rows && a.rows.length === 5, a.rows && String(a.rows.length));
    const b = run(src, { method: 'adaptive' });
    check('適応的でも大津の値を参考に出す', !!rowVal(b.rows, '大津なら'));
    check('適応的では窓の大きさを出す', /×/.test(rowVal(b.rows, '窓') || ''));
  }
}

/* --- 3-5. モルフォロジーの中身 --- */
console.log('3-5) モルフォロジーの中身');
{
  const U = IL.util;
  const op = IL.opById['morphology'];

  const run = (over, img) => {
    const p = Object.assign(IL.defaultParams(op), over);
    const sink = {};
    const out = op.apply(img || src, p, sink);
    return { out, rows: sink.report ? sink.report.rows : null };
  };
  const gray = (img) => {
    const a = new Float64Array(img.width * img.height);
    for (let i = 0, j = 0; i < a.length; i++, j += 4) a[i] = img.data[j];
    return a;
  };
  /* a のすべての画素が b 以下か */
  const allLE = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] > b[i] + 1) return false;
    return true;
  };
  /* 比較の基準は「op が入力に使う面」＝輝度。出力はグレーなので赤成分でよいが、
     入力側を赤成分で取ると基準がずれる（最初これで6件落とした） */
  const G = U.toGrayPlane(src);
  const base = { pre: false, invert: false, shape: 'rect', radius: 2, iter: 1 };

  /* 膨張は増える方向、収縮は減る方向 */
  {
    const dil = gray(run(Object.assign({}, base, { opkind: 'dilate' })).out);
    const ero = gray(run(Object.assign({}, base, { opkind: 'erode' })).out);
    check('膨張は元より暗くならない', allLE(G, dil));
    check('収縮は元より明るくならない', allLE(ero, G));
    check('収縮 ≦ 膨張', allLE(ero, dil));
  }

  /* オープニングは元以下、クロージングは元以上 */
  {
    const opn = gray(run(Object.assign({}, base, { opkind: 'open' })).out);
    const cls = gray(run(Object.assign({}, base, { opkind: 'close' })).out);
    check('オープニングは元を超えない', allLE(opn, G));
    check('クロージングは元を下回らない', allLE(G, cls));
  }

  /* 冪等性：オープニング／クロージングは2回かけても変わらない。
     膨張・収縮のほうは反復するたびに進む（＝変わる） */
  {
    const o1 = run(Object.assign({}, base, { opkind: 'open', iter: 1 })).out;
    const o2 = run(Object.assign({}, base, { opkind: 'open', iter: 2 })).out;
    check('オープニングが冪等', maxAbsDiff(o1, o2) === 0, '最大差 ' + maxAbsDiff(o1, o2));
    const c1 = run(Object.assign({}, base, { opkind: 'close', iter: 1 })).out;
    const c2 = run(Object.assign({}, base, { opkind: 'close', iter: 2 })).out;
    check('クロージングが冪等', maxAbsDiff(c1, c2) === 0, '最大差 ' + maxAbsDiff(c1, c2));
    const d1 = run(Object.assign({}, base, { opkind: 'dilate', iter: 1 })).out;
    const d2 = run(Object.assign({}, base, { opkind: 'dilate', iter: 2 })).out;
    check('膨張は反復すると進む', maxAbsDiff(d1, d2) > 0);
  }

  /* 四角なら「半径1で2回」と「半径2で1回」が同じ（構造要素の足し合わせ） */
  {
    const a = run(Object.assign({}, base, { opkind: 'dilate', radius: 1, iter: 2 })).out;
    const b = run(Object.assign({}, base, { opkind: 'dilate', radius: 2, iter: 1 })).out;
    check('四角は 半径1×2回 = 半径2×1回', maxAbsDiff(a, b) === 0, '最大差 ' + maxAbsDiff(a, b));
  }

  /* トップハット = 元 − オープニング */
  {
    const opn = gray(run(Object.assign({}, base, { opkind: 'open' })).out);
    const top = gray(run(Object.assign({}, base, { opkind: 'tophat', stretch: false })).out);
    let worst = 0;
    for (let i = 0; i < top.length; i++) worst = Math.max(worst, Math.abs(top[i] - (G[i] - opn[i])));
    check('トップハットが 元 − オープニング と一致', worst <= 1, '最大差 ' + worst);
  }

  /* 双対性：膨張(255−f) = 255 − 収縮(f) */
  {
    const dInv = gray(run(Object.assign({}, base, { opkind: 'dilate', invert: true })).out);
    const ero = gray(run(Object.assign({}, base, { opkind: 'erode' })).out);
    let worst = 0;
    for (let i = 0; i < dInv.length; i++) worst = Math.max(worst, Math.abs(dInv[i] - (255 - ero[i])));
    check('膨張と収縮が双対（白黒を入れ替えると入れ替わる）', worst <= 1, '最大差 ' + worst);
  }

  /* 分離して回した四角が、素朴に 2 次元で回したのと一致するか。
     ここが狂うと四角の結果が丸ごとずれるので、独立に組んで突き合わせる */
  {
    const r = 3;
    const dil = gray(run(Object.assign({}, base, { opkind: 'dilate', radius: r })).out);
    let worst = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let best = -1;
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx));
            const v = G[yy * W + xx];
            if (v > best) best = v;
          }
        }
        worst = Math.max(worst, Math.abs(dil[y * W + x] - best));
      }
    }
    check('分離した四角が素朴な2次元と一致', worst <= 1, '最大差 ' + worst);
  }

  /* 構造要素の包含関係：十字 ⊂ 円 ⊂ 四角 なので、膨張の結果もその順に大きい */
  {
    const cr = gray(run(Object.assign({}, base, { opkind: 'dilate', shape: 'cross', radius: 3 })).out);
    const dk = gray(run(Object.assign({}, base, { opkind: 'dilate', shape: 'disk', radius: 3 })).out);
    const rc = gray(run(Object.assign({}, base, { opkind: 'dilate', shape: 'rect', radius: 3 })).out);
    check('膨張は 十字 ≦ 円 ≦ 四角', allLE(cr, dk) && allLE(dk, rc));
  }

  /* 二値にしてから：膨張で白が増え、収縮で減る */
  {
    const rowVal = (rows, label) => {
      const r = rows.filter((x) => x[0] === label)[0];
      return r ? r[1] : null;
    };
    const pct = (over) => {
      const v = rowVal(run(Object.assign({}, over, { pre: true })).rows, '白の割合');
      return v.split('→').map((s) => parseFloat(s));
    };
    const d = pct({ opkind: 'dilate', shape: 'rect', radius: 2, iter: 1, invert: false });
    const e = pct({ opkind: 'erode', shape: 'rect', radius: 2, iter: 1, invert: false });
    check('二値化してから膨張すると白が増える', d[1] > d[0], d.join(' → '));
    check('二値化してから収縮すると白が減る', e[1] < e[0], e.join(' → '));
    check('前の白の割合は操作によらず同じ', Math.abs(d[0] - e[0]) < 1e-9);
    /* 出力が 0 と 255 だけであること（二値のまま保たれる） */
    const out = run({ pre: true, opkind: 'open', shape: 'disk', radius: 2 }).out;
    const set = new Set();
    for (let i = 0; i < out.data.length; i += 4) set.add(out.data[i]);
    check('二値のまま保たれる', [...set].every((v) => v === 0 || v === 255), [...set].join(','));
  }

  /* オープニングは小さな白い粒を落とし、クロージングは小さな黒い穴を埋める */
  {
    const w = 61, h = 61;
    const img = new ImageData(w, h);
    const put = (x, y, v) => {
      const j = (y * w + x) * 4;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 0);
    /* 大きな白い四角（20×20）と、離れたところに白い1点 */
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) put(x, y, 255);
    put(45, 45, 255);
    /* 大きな四角の中に黒い1点の穴 */
    put(15, 15, 0);

    const at = (out, x, y) => out.data[(y * w + x) * 4];
    const o = run({ pre: false, opkind: 'open', shape: 'rect', radius: 1, iter: 1 }, img).out;
    check('オープニングが孤立した白い点を落とす', at(o, 45, 45) === 0, String(at(o, 45, 45)));
    check('オープニングが大きな四角の中を残す', at(o, 12, 20) === 255, String(at(o, 12, 20)));
    const c = run({ pre: false, opkind: 'close', shape: 'rect', radius: 1, iter: 1 }, img).out;
    check('クロージングが小さな黒い穴を埋める', at(c, 15, 15) === 255, String(at(c, 15, 15)));
    check('クロージングは孤立した白い点を残す', at(c, 45, 45) === 255, String(at(c, 45, 45)));
  }

  /* report の形 */
  {
    const a = run({ pre: true, opkind: 'open', shape: 'cross', radius: 3 });
    check('モルフォロジーが report を返す', !!a.rows);
    check('report の行が4本', a.rows && a.rows.length === 4, a.rows && String(a.rows.length));
    const se = a.rows.filter((r) => r[0] === '構造要素')[0][1];
    check('十字の画素数が 4r+1', /十字 7 × 7（13 画素）/.test(se), se);
    const b = run({ pre: true, opkind: 'open', shape: 'rect', radius: 3 });
    check('四角の画素数が (2r+1)²',
          /四角 7 × 7（49 画素）/.test(b.rows.filter((r) => r[0] === '構造要素')[0][1]));
  }
}

/* --- 3-6. デモザイクの中身 --- */
console.log('3-6) デモザイクの中身');
{
  const U = IL.util;
  const op = IL.opById['demosaic'];

  const run = (over, img) => {
    const p = Object.assign(IL.defaultParams(op), over);
    const sink = {};
    const out = op.apply(img || src, p, sink);
    return { out, rows: sink.report ? sink.report.rows : null };
  };
  const at = (img, x, y, c) => img.data[(y * img.width + x) * 4 + c];

  /* CFA の並びの取り決め：pattern は左上 2×2 を
     「(0,0) (1,0) (0,1) (1,1)」の順に並べた文字列。
     Bayer 生データ（モザイク表示）は、受け取った色のチャンネルだけに値が入る。 */
  {
    const pats = { RGGB: [0, 1, 1, 2], BGGR: [2, 1, 1, 0],
                   GRBG: [1, 0, 2, 1], GBRG: [1, 2, 0, 1] };
    for (const pat of Object.keys(pats)) {
      const b = run({ view: 'bayer', bayerview: 'color', pattern: pat }).out;
      const want = pats[pat];
      let ok = true;
      for (let y = 0; y < H && ok; y++) {
        for (let x = 0; x < W; x++) {
          const c = want[(y & 1) * 2 + (x & 1)];
          for (let k = 0; k < 3; k++) {
            if (k !== c && at(b, x, y, k) !== 0) { ok = false; break; }
          }
          if (!ok) break;
        }
      }
      check('Bayer(' + pat + ') が1画素1色になっている', ok);
    }
  }

  /* 標本の位置では、どの手法でも元の値がそのまま残るはず
     （その色は測れているので、推測で書き換えてはいけない）。
     バイリニアの畳み込み・AHD の色差補間とも、この性質を保つ形になっている。 */
  {
    const bil = run({ view: 'bilinear', pattern: 'RGGB' }).out;
    const ahd = run({ view: 'ahd', pattern: 'RGGB', med: 0 }).out;
    const cfa = [0, 1, 1, 2];
    let wb = 0, wa = 0;
    /* 端は鏡映が入るので内側だけ見る */
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const c = cfa[(y & 1) * 2 + (x & 1)];
        const ref = at(src, x, y, c);
        wb = Math.max(wb, Math.abs(at(bil, x, y, c) - ref));
        wa = Math.max(wa, Math.abs(at(ahd, x, y, c) - ref));
      }
    }
    check('バイリニアが標本の値を保つ', wb <= 1, '最大差 ' + wb);
    check('AHD が標本の値を保つ', wa <= 1, '最大差 ' + wa);
  }

  /* 灰色一色の絵は、どう補間しても同じ灰色に戻るはず（色が湧いてはいけない）。
     ここが崩れると、平坦なところに色ムラが出る。端まで含めて見る。 */
  {
    const flat = new ImageData(W, H);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      flat.data[j] = 120; flat.data[j + 1] = 120; flat.data[j + 2] = 120; flat.data[j + 3] = 255;
    }
    for (const view of ['bilinear', 'ahd']) {
      const o = run({ view, pattern: 'RGGB', med: 0 }, flat).out;
      let worst = 0;
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(o.data[j + k] - 120));
      }
      check(view + ' が一様な灰色を保つ（端も含む）', worst <= 1, '最大差 ' + worst);
    }
  }

  /* 縦縞の絵：横方向には模様があり、縦方向には一定。
     AHD は「横向きに補間する」を選べるので、バイリニアより誤差が小さくなるはず。
     これが AHD を入れる理由そのものなので、崩れたら落とす。 */
  {
    const stripes = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = (x % 6 < 3) ? 210 : 40;
        const j = (y * W + x) * 4;
        stripes.data[j] = v; stripes.data[j + 1] = v; stripes.data[j + 2] = v;
        stripes.data[j + 3] = 255;
      }
    }
    const bil = run({ view: 'bilinear' }, stripes).out;
    const ahd = run({ view: 'ahd', med: 0 }, stripes).out;
    const pb = U.psnr(stripes, bil), pa = U.psnr(stripes, ahd);
    check('縦縞で AHD がバイリニアを上回る', pa > pb,
          'バイリニア ' + pb.toFixed(1) + ' dB / AHD ' + pa.toFixed(1) + ' dB');

    /* 偽色の量も測る。白黒の縞なので、色が付いたぶんがそのまま偽色 */
    const chroma = (img) => {
      let s = 0;
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        const r = img.data[j], g = img.data[j + 1], b = img.data[j + 2];
        s += Math.abs(-0.168736 * r - 0.331264 * g + 0.5 * b) +
             Math.abs(0.5 * r - 0.418688 * g - 0.081312 * b);
      }
      return s / (2 * W * H);
    };
    const cb = chroma(bil), ca = chroma(ahd);
    check('縦縞で AHD のほうが偽色が少ない', ca < cb,
          'バイリニア ' + cb.toFixed(2) + ' / AHD ' + ca.toFixed(2));
  }

  /* 色差メディアンは偽色を減らす方向にしか働かない（白黒の縞で確かめる） */
  {
    const stripes = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = ((x + y) % 4 < 2) ? 220 : 30;     /* 斜め縞。方向の判定が割れやすい */
        const j = (y * W + x) * 4;
        stripes.data[j] = v; stripes.data[j + 1] = v; stripes.data[j + 2] = v;
        stripes.data[j + 3] = 255;
      }
    }
    const chroma = (img) => {
      let s = 0;
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        const r = img.data[j], g = img.data[j + 1], b = img.data[j + 2];
        s += Math.abs(-0.168736 * r - 0.331264 * g + 0.5 * b) +
             Math.abs(0.5 * r - 0.418688 * g - 0.081312 * b);
      }
      return s / (2 * W * H);
    };
    const c0 = chroma(run({ view: 'ahd', med: 0 }, stripes).out);
    const c1 = chroma(run({ view: 'ahd', med: 1 }, stripes).out);
    const c3 = chroma(run({ view: 'ahd', med: 3 }, stripes).out);
    check('色差メディアン1回で偽色が減る', c1 <= c0, c0.toFixed(2) + ' → ' + c1.toFixed(2));
    check('色差メディアン3回でさらに減る', c3 <= c1, c1.toFixed(2) + ' → ' + c3.toFixed(2));
  }

  /* RGGB と BGGR は「赤と青が入れ替わるだけ」の関係。
     入力の R と B を入れ替えて RGGB で解いた結果と、
     元の入力を BGGR で解いて R と B を戻した結果を突き合わせる。

     バイリニアはこれがぴたり一致する（赤の埋め方と青の埋め方が同じ式なので）。
     AHD は一致しない。方向を選ぶ判定を CIELab でやっており、Lab は赤と青を
     対等に扱わないためで、これは不具合ではない。ここでは
     「センサが受け取る値（Bayer 生データ）までは完全に同じ」ことを押さえておく。 */
  {
    const swapped = new ImageData(W, H);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      swapped.data[j] = src.data[j + 2];
      swapped.data[j + 1] = src.data[j + 1];
      swapped.data[j + 2] = src.data[j];
      swapped.data[j + 3] = 255;
    }
    const rawA = run({ view: 'bayer', bayerview: 'gray', pattern: 'RGGB' }, swapped).out;
    const rawB = run({ view: 'bayer', bayerview: 'gray', pattern: 'BGGR' }).out;
    check('RGGB と BGGR で Bayer 生データが一致', maxAbsDiff(rawA, rawB) === 0,
          '最大差 ' + maxAbsDiff(rawA, rawB));

    const a = run({ view: 'bilinear', pattern: 'RGGB' }, swapped).out;
    const b = run({ view: 'bilinear', pattern: 'BGGR' }).out;
    let worst = 0;
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      worst = Math.max(worst, Math.abs(a.data[j] - b.data[j + 2]),
                       Math.abs(a.data[j + 1] - b.data[j + 1]),
                       Math.abs(a.data[j + 2] - b.data[j]));
    }
    check('バイリニアが RGGB と BGGR で赤青対称', worst <= 1, '最大差 ' + worst);
  }

  /* 実画像で AHD がバイリニアを上回ること（教材の主張そのもの） */
  {
    const bil = run({ view: 'bilinear' }).out;
    const ahd = run({ view: 'ahd' }).out;
    const pb = U.psnr(src, bil), pa = U.psnr(src, ahd);
    check('テスト画像で AHD が PSNR で上回る', pa > pb,
          'バイリニア ' + pb.toFixed(1) + ' dB / AHD ' + pa.toFixed(1) + ' dB');
  }

  /* 4分割タイルと report の形 */
  {
    const t = run({ view: 'tile' });
    check('タイル表示が元と同じ大きさ', t.out.width === W && t.out.height === H,
          t.out.width + '×' + t.out.height);
    check('デモザイクが report を返す', !!t.rows);
    check('report の行が5本', t.rows && t.rows.length === 5, t.rows && String(t.rows.length));
    const cfaRow = t.rows.filter((r) => r[0] === 'CFA の並び')[0][1];
    check('report に CFA の並びが出る', /RGGB/.test(cfaRow), cfaRow);
    const psnrRows = t.rows.filter((r) => r[0] === 'バイリニア' || r[0] === 'AHD');
    check('report に2手法の行がある', psnrRows.length === 2);
    const stars = psnrRows.map((r) => (r[1].match(/★/g) || []).length).reduce((a, b) => a + b, 0);
    check('★が PSNR と SSIM に1つずつ', stars === 2, String(stars));
  }
}

/* --- 3-7. 幾何変換の中身（アフィン・レンズ歪み） --- */
console.log('3-7) 幾何変換の中身');
{
  const U = IL.util;
  const af = IL.opById['affine'];
  const ld = IL.opById['lensdist'];

  const run = (op, over, img) => {
    const p = Object.assign(IL.defaultParams(op), over);
    const sink = {};
    const out = op.apply(img || src, p, sink);
    return { out, rows: sink.report ? sink.report.rows : null };
  };
  const rowOf = (rows, name) => (rows.filter((r) => r[0] === name)[0] || [])[1];

  /* --- 補間そのもの（U.sampleImage） --- */
  {
    const px = new Float32Array(3);
    /* 格子点の真上を読んだら、どの補間でもその画素そのものが返るはず */
    let worst = 0;
    for (const mode of ['nearest', 'bilinear', 'bicubic']) {
      for (const [x, y] of [[10, 10], [1, 1], [W - 2, H - 2], [40, 30]]) {
        U.sampleImage(src, x, y, mode, 'clamp', px);
        const j = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(px[k] - src.data[j + k]));
      }
    }
    check('格子点では3種の補間とも元の画素を返す', worst < 1e-3, '最大差 ' + worst);

    /* バイリニアの中点は、隣り合う4画素の平均 */
    U.sampleImage(src, 20.5, 30.5, 'bilinear', 'clamp', px);
    let want = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      want += src.data[((30 + dy) * W + 20 + dx) * 4] / 4;
    }
    check('バイリニアの中点が4画素の平均', Math.abs(px[0] - want) < 1e-3,
          px[0].toFixed(3) + ' / ' + want.toFixed(3));

    /* Catmull-Rom の重みの総和は 1（そうでないと明るさが変わる） */
    for (const t of [0, 0.25, 0.5, 0.75]) {
      let s = 0;
      for (let i = -1; i <= 2; i++) s += U.cubicWeight(t, i);
      check('バイキュービックの重みの和が 1（t=' + t + '）', Math.abs(s - 1) < 1e-6, String(s));
    }

    /* 'zero' は外を黒、'clamp' は端の値、'mirror' は折り返し */
    U.sampleImage(src, -5, 10, 'nearest', 'zero', px);
    check('外側 zero が黒を返す', px[0] === 0 && px[1] === 0 && px[2] === 0);
    U.sampleImage(src, -5, 10, 'nearest', 'clamp', px);
    check('外側 clamp が端の画素を返す', px[0] === src.data[(10 * W) * 4], String(px[0]));
    U.sampleImage(src, -3, 10, 'nearest', 'mirror', px);
    check('外側 mirror が折り返す', px[0] === src.data[(10 * W + 3) * 4], String(px[0]));
  }

  /* --- アフィン変換 --- */
  {
    /* 何もしない設定（回転0・拡大1・せん断0・移動0）は恒等でなければおかしい */
    for (const interp of ['nearest', 'bilinear', 'bicubic']) {
      const o = run(af, { rot: 0, zoom: 1, shear: 0, tx: 0, ty: 0, interp }).out;
      check('アフィンの既定値が恒等（' + interp + '）', maxAbsDiff(src, o) === 0,
            '最大差 ' + maxAbsDiff(src, o));
    }

    /* 180° 回転を2回かけると元に戻る（画素の真上に乗るので補間が効かない） */
    {
      const a = run(af, { rot: 180, edge: 'clamp' }).out;
      const b = run(af, { rot: 180, edge: 'clamp' }, a).out;
      check('180° を2回で元に戻る', maxAbsDiff(src, b) === 0, '最大差 ' + maxAbsDiff(src, b));
    }

    /* 90° の往復は完全一致（PSNR が ∞）。半端な角度では有限に落ちる */
    {
      const r90 = run(af, { rot: 90, roundtrip: true, edge: 'clamp' }).rows;
      check('90° の往復が完全一致', /∞/.test(rowOf(r90, '往復後の PSNR')),
            rowOf(r90, '往復後の PSNR'));
      const r20 = run(af, { rot: 20, roundtrip: true, edge: 'clamp' }).rows;
      const v = parseFloat(rowOf(r20, '往復後の PSNR'));
      check('20° の往復は誤差が残る', isFinite(v) && v > 15 && v < 60,
            rowOf(r20, '往復後の PSNR'));
    }

    /* 平行移動は素直にずれるはず（整数画素ぶんなら補間も効かない） */
    {
      const shift = Math.round(W * 0.1);            /* tx = 10 % */
      const o = run(af, { rot: 0, zoom: 1, tx: 10, edge: 'clamp', interp: 'nearest' }).out;
      let worst = 0;
      for (let y = 5; y < H - 5; y++) {
        for (let x = shift + 5; x < W - 5; x++) {
          const a = o.data[(y * W + x) * 4];
          const b = src.data[(y * W + x - shift) * 4];
          worst = Math.max(worst, Math.abs(a - b));
        }
      }
      check('平行移動が指定どおりずれる', worst === 0, '最大差 ' + worst);
    }

    /* 拡大してから同じだけ縮めると、だいたい元に戻る */
    {
      const up = run(af, { rot: 0, zoom: 2, edge: 'clamp', interp: 'bilinear' }).out;
      const back = run(af, { rot: 0, zoom: 0.5, edge: 'clamp', interp: 'bilinear' }, up).out;
      const ps = U.psnr(src, back);
      check('2倍 → 0.5倍でだいたい戻る', ps > 20, ps.toFixed(1) + ' dB');
    }

    /* 補間の重みは和が 1 なので、一様な絵は変換しても一様のまま
       （端まで含めるので edge は clamp） */
    {
      const flat = new ImageData(W, H);
      for (let i = 0, j = 0; i < W * H; i++, j += 4) {
        flat.data[j] = 90; flat.data[j + 1] = 90; flat.data[j + 2] = 90; flat.data[j + 3] = 255;
      }
      for (const interp of ['nearest', 'bilinear', 'bicubic']) {
        const o = run(af, { rot: 33, zoom: 1.4, shear: 0.3, edge: 'clamp', interp }, flat).out;
        let worst = 0;
        for (let i = 0, j = 0; i < W * H; i++, j += 4) worst = Math.max(worst, Math.abs(o.data[j] - 90));
        check('一様な絵はアフィンで変わらない（' + interp + '）', worst <= 1, '最大差 ' + worst);
      }
    }

    /* report の形 */
    {
      const r = run(af, { rot: 20 }).rows;
      check('アフィンが report を返す', !!r);
      check('report の行が4本', r.length === 4, String(r.length));
      check('外を読んだ画素が 0〜100 %', /^\d+\.\d %$/.test(rowOf(r, '画像の外を読んだ画素')),
            rowOf(r, '画像の外を読んだ画素'));
      const r2 = run(af, { rot: 20, roundtrip: true }).rows;
      check('往復のとき report が6本になる', r2.length === 6, String(r2.length));
    }
  }

  /* --- レンズ歪み --- */
  {
    /* k₁ = k₂ = 0 は恒等（歪ませても補正しても同じ絵） */
    for (const kind of ['apply', 'correct']) {
      const o = run(ld, { kind, k1: 0, k2: 0, grid: false, edge: 'clamp' }).out;
      check('歪み係数 0 が恒等（' + kind + '）', maxAbsDiff(src, o) <= 1,
            '最大差 ' + maxAbsDiff(src, o));
    }

    /* 歪ませる ⇄ 補正する は逆向き。
       樽型（k₁ < 0）の絵では、外側にあるものほど中心寄りに写る（＝画角が広く写る）。
       だから〈歪ませる〉と点は中心へ寄り、〈補正する〉と外へ戻る。
       中心から 30 px の白い点がどちらへ動くかで見る（枠内に収まる距離を選ぶこと）。 */
    {
      const img = new ImageData(W, H);
      for (let i = 0, j = 0; i < W * H; i++, j += 4) { img.data[j + 3] = 255; }
      const cx = (W - 1) / 2, cy = (H - 1) / 2;
      const px0 = Math.round(cx + 30);
      const cyi = Math.round(cy);
      for (let y = cyi - 1; y <= cyi + 1; y++) {
        for (let x = px0 - 1; x <= px0 + 1; x++) {
          const j = (y * W + x) * 4;
          img.data[j] = 255; img.data[j + 1] = 255; img.data[j + 2] = 255;
        }
      }
      /* 中心より右側で一番明るい画素の位置。暗いままなら -1 を返す */
      const peakX = (o) => {
        let best = -1, bx = -1;
        for (let x = cyi >= 0 ? Math.ceil(cx) : 0; x < W; x++) {
          const v = o.data[(cyi * W + x) * 4];
          if (v > best) { best = v; bx = x; }
        }
        return best > 100 ? bx : -1;
      };
      const opts = { grid: false, edge: 'clamp', interp: 'nearest', k1: -0.4 };
      const bar = run(ld, Object.assign({ kind: 'apply' }, opts), img).out;
      const cor = run(ld, Object.assign({ kind: 'correct' }, opts), img).out;
      check('歪ませる（樽型）と点が中心へ寄る', peakX(bar) > 0 && peakX(bar) < px0 - 1,
            px0 + ' → ' + peakX(bar));
      check('補正すると点が外へ戻る', peakX(cor) > px0 + 1,
            px0 + ' → ' + peakX(cor));
    }

    /* 歪ませてから補正すると、だいたい元に戻る（完全には戻らない） */
    {
      const r = run(ld, { kind: 'roundtrip', k1: -0.25, grid: false, edge: 'clamp' }).rows;
      const v = parseFloat(rowOf(r, '往復後の PSNR'));
      check('歪み → 補正でだいたい戻る', v > 20, rowOf(r, '往復後の PSNR'));
      check('完全には戻らない', isFinite(v), rowOf(r, '往復後の PSNR'));
      const cov = parseFloat(rowOf(r, '比べた範囲'));
      check('比べた範囲が 50 % 以上', cov > 50, rowOf(r, '比べた範囲'));
    }

    /* 歪みが強いほど戻りが悪くなる（外周で画素が間引かれるため） */
    {
      const at = (k1) => parseFloat(rowOf(
        run(ld, { kind: 'roundtrip', k1, grid: false, edge: 'clamp' }).rows, '往復後の PSNR'));
      const weak = at(-0.1), strong = at(-0.4);
      check('歪みが強いほど往復の誤差が大きい', strong < weak,
            'k₁=−0.1 で ' + weak.toFixed(1) + ' dB / k₁=−0.4 で ' + strong.toFixed(1) + ' dB');
    }

    /* Newton 法で作った逆写像の表が、順方向の式とちゃんと逆になっているか。
       op の中の表には触れず、ここで独立に確かめる */
    {
      const k1 = -0.25, k2 = 0.05;
      const f = (ru) => ru * (1 + k1 * ru * ru + k2 * ru * ru * ru * ru);
      /* op が使うのと同じ手順（Newton 法）を素朴に書いて、往復が合うか見る */
      const invert = (rd) => {
        let ru = rd;
        for (let i = 0; i < 40; i++) {
          const r2 = ru * ru;
          const df = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2;
          if (df < 1e-6) break;
          ru -= (ru * (1 + k1 * r2 + k2 * r2 * r2) - rd) / df;
        }
        return ru;
      };
      let worst = 0;
      for (let i = 0; i <= 20; i++) {
        const ru = i / 20;
        worst = Math.max(worst, Math.abs(invert(f(ru)) - ru));
      }
      check('Newton 法の逆写像が順方向と逆になる', worst < 1e-6, '最大差 ' + worst);
    }

    /* report の形 */
    {
      const r = run(ld, { kind: 'apply', k1: -0.25 }).rows;
      check('レンズ歪みが report を返す', !!r);
      check('report の行が5本', r.length === 5, String(r.length));
      check('樽型と表示される', /樽型/.test(rowOf(r, 'すること')), rowOf(r, 'すること'));
      const rp = run(ld, { kind: 'apply', k1: 0.25 }).rows;
      check('糸巻き型と表示される', /糸巻き型/.test(rowOf(rp, 'すること')), rowOf(rp, 'すること'));
      const rr = run(ld, { kind: 'roundtrip', k1: -0.25 }).rows;
      check('往復のとき report が7本になる', rr.length === 7, String(rr.length));
    }
  }
}

/* --- 4. 帯に切って計算しても、一枚で計算したのと同じ結果になるか ---
 *
 * Worker 化の土台になる性質なので、ここが崩れると画像に横縞が出る。
 * step を変えて何通りか試し、1バイトでも違えば落とす。 */
console.log('4) 帯に切っても結果が変わらないか');

function runBanded(op, src, p, step) {
  const n = op.stages ? op.stages(p) : 1;
  let cur = src;
  for (let s = 0; s < n; s++) {
    const ctx = op.prepare ? op.prepare(cur, p) : null;
    const dst = new ImageData(cur.width, cur.height);
    for (let y = 0; y < cur.height; y += step) {
      const y1 = Math.min(cur.height, y + step);
      const band = op.kernel(cur, p, y, y1, ctx);
      if (band.width !== cur.width || band.height !== y1 - y) {
        throw new Error('帯のサイズが違う: ' + band.width + '×' + band.height +
                        '（期待 ' + cur.width + '×' + (y1 - y) + '）');
      }
      dst.data.set(band.data, y * cur.width * 4);
    }
    cur = dst;
  }
  return cur;
}

const bandCases = [
  ['blur', { kind: 'gauss', sigma: 2 }],
  ['blur', { kind: 'gauss', sigma: 6 }],
  ['blur', { kind: 'box', radius: 5 }],
  ['median', { radius: 1, iter: 1 }],
  ['median', { radius: 3, iter: 1 }],
  ['median', { radius: 2, iter: 3 }],          /* 反復＝段が正しく回るか */
  ['bilateral', { sigmaS: 3, sigmaC: 30, metric: 'luma' }],
  ['bilateral', { sigmaS: 1, sigmaC: 60, metric: 'rgb' }],
  /* 周波数領域は prepare で一枚作りきって kernel が切り出すだけなので、
     どこで切っても同じでなければおかしい。念のため全部の見せ方を通す */
  ['fft', { show: 'power' }],
  ['fft', { show: 'phaseonly', edge: 'hann' }],
  ['fftfilter', { kind: 'lowpass', shape: 'ideal', cut: 0.1 }],
  ['fftfilter', { kind: 'notch', nu: 0.2, nv: 0.1, nr: 0.04, channels: 'luma' }],
  ['fftfilter', { kind: 'bandpass', shape: 'butter', show: 'spectrum' }],
  ['fftmask', { soft: 3 }],
  /* ノイズは位置ハッシュなので、どこで切っても同じでなければおかしい
     （順番に引く乱数だと、ここで帯ごとの食い違いが出る） */
  ['noise', { kind: 'gauss', sigma: 20, seed: 1, color: false }],
  ['noise', { kind: 'sp', prob: 0.08, seed: 2, color: true }],
  ['noise', { kind: 'shot', peak: 12, seed: 3, color: false }],
  /* 周期ノイズは乱数を使わないが、座標だけで決まることを帯の一致で押さえておく
     （x, y ではなく「帯の中での y」を使ってしまうと、ここで継ぎ目が出る） */
  ['noise', { kind: 'periodic', pperiod: 5, pangle: 27, pamp: 30 }],
  ['noise', { kind: 'periodic', pperiod: 12.5, pangle: 118, pamp: 55 }],
  /* 比較 op は prepare で作りきる形。U.opKernel 越しに他の処理を呼ぶので、
     Worker 側の入口（worker.js が書き出すほう）もここで通る */
  ['denoisecmp', { view: 'tile', kind: 'gauss' }],
  ['denoisecmp', { view: 'median', kind: 'sp' }],
  /* 二値化も prepare で閾値と窓の平均を作りきる形。帯ごとに閾値が動いたら
     境目に横縞が出るので、ここで押さえる */
  ['threshold', { method: 'otsu' }],
  ['threshold', { method: 'fixed', thr: 100, invert: true }],
  ['threshold', { method: 'adaptive', radius: 9, bias: 4, stat: 'mean' }],
  ['threshold', { method: 'adaptive', radius: 5, bias: 0, stat: 'gauss' }],
  /* モルフォロジーも prepare で作りきる形。二値化を U.opKernel 越しに呼ぶので、
     Worker 側の入口もここで通る */
  ['morphology', { opkind: 'dilate', shape: 'rect', radius: 2, pre: true }],
  ['morphology', { opkind: 'open', shape: 'cross', radius: 3, pre: false, invert: true }],
  ['morphology', { opkind: 'close', shape: 'disk', radius: 2, pre: false, iter: 2 }],
  ['morphology', { opkind: 'tophat', shape: 'rect', radius: 4, pre: false, stretch: true }],
  /* デモザイクも prepare で作りきる形。CFA の位相が帯の切り方で狂わないこと
     （raw の読み方を y だけで決めていると、帯ごとに色がずれる）も、ここで押さえる */
  ['demosaic', { view: 'tile', pattern: 'RGGB', med: 1 }],
  ['demosaic', { view: 'ahd', pattern: 'GRBG', med: 0 }],
  ['demosaic', { view: 'bilinear', pattern: 'BGGR' }],
  ['demosaic', { view: 'bayer', pattern: 'GBRG', bayerview: 'gray' }],
  /* 「原画」表示は U.cloneImageData を通る。workerExports への載せ忘れは
     ここでしか捕まらない（ページ側では動いてしまう） */
  ['demosaic', { view: 'orig' }],
  /* 幾何変換も prepare で作りきる形。3種類の補間と3種類の縁の扱いを
     Worker 側でも通しておく（U.sampleImage の載せ忘れはここで捕まる） */
  ['affine', { rot: 20, interp: 'bilinear', edge: 'zero' }],
  ['affine', { rot: -33, zoom: 1.6, shear: 0.3, interp: 'bicubic', edge: 'mirror' }],
  ['affine', { rot: 12, tx: 10, ty: -8, interp: 'nearest', edge: 'clamp', roundtrip: true }],
  ['lensdist', { kind: 'apply', k1: -0.25, grid: true, interp: 'bilinear' }],
  ['lensdist', { kind: 'correct', k1: 0.2, k2: -0.05, grid: false, interp: 'bicubic', edge: 'clamp' }],
  ['lensdist', { kind: 'roundtrip', k1: -0.3, grid: false, interp: 'nearest', edge: 'clamp' }]
];

for (const [id, over] of bandCases) {
  const op = IL.opById[id];
  const p = Object.assign(IL.defaultParams(op), over);
  const whole = op.apply(src, p);
  for (const step of [1, 5, 23, H]) {
    let out = null, err = null;
    try { out = runBanded(op, src, p, step); } catch (e) { err = e; }
    const label = id + ' ' + JSON.stringify(over) + ' step=' + step;
    if (err) { check(label, false, err.message); continue; }
    check(label + ' が一枚計算と一致', maxAbsDiff(whole, out) === 0, '最大差 ' + maxAbsDiff(whole, out));
  }
}

/* kernel を持つ op は halo / cost もそろっているか（付け忘れ防止） */
for (const op of IL.ops) {
  if (typeof op.kernel !== 'function') continue;
  const p = IL.defaultParams(op);
  check(op.id + ' に cost がある', typeof op.cost === 'function');
  check(op.id + ' の cost が正の数', op.cost && op.cost(640, 480, p) > 0);
  check(op.id + ' に halo がある', typeof op.halo === 'function');
  check(op.id + ' の halo が 0 以上の整数', op.halo && op.halo(p) >= 0 && Number.isFinite(op.halo(p)));
}

/* route を立てた op は、見積りが軽くてもメインスレッドの同期実行に落ちないこと。
   処理時間を見せる実演がこれで成り立っているので、外れたら落とす
   （Node には Worker が無いので mode は 'main' になる。'sync' でなければよい） */
for (const op of IL.ops) {
  if (op.route === undefined) continue;
  check(op.id + ' の route は "worker" だけ', op.route === 'worker', String(op.route));
  check(op.id + ' に kernel がある（route を立てるなら必須）', typeof op.kernel === 'function');
  const p = IL.defaultParams(op);
  const est = op.cost(640, 480, p);
  const job = IL.jobs.run(op, src, p, {});
  job.cancel();
  check(op.id + ' が軽くても同期実行に落ちない', job.mode !== 'sync',
        'mode=' + job.mode + '（見積り ' + est.toFixed(0) + ' ms・しきい値 ' +
        IL.jobs.threshold + ' ms）');
}

/* bench を立てた op は route も立っていること（メインスレッドで何度まわしても
   数字は安定しないので、経路の固定とセットでなければ意味がない）。
   また、何度まわしても結果が変わらないこと＝prepare が入力を壊さないこと。 */
for (const op of IL.ops) {
  if (op.bench === undefined) continue;
  check(op.id + ' の bench は 2 以上の整数', Number.isInteger(op.bench) && op.bench >= 2,
        String(op.bench));
  check(op.id + ' は bench と route がセット', op.route === 'worker', String(op.route));
  const p = IL.defaultParams(op);
  const a = op.apply(src, p);
  const b = op.apply(src, p);            /* 空回しのぶん、同じ入力で2回走る */
  check(op.id + ' は2回まわしても結果が同じ', maxAbsDiff(a, b) === 0,
        '最大差 ' + maxAbsDiff(a, b));
}

/* --- 5. Worker 用に文字列化したコードが、そのまま動くか ---
 *
 * file:// では importScripts が使えないので、kernel と prepare は
 * toString() で文字列にして Blob に詰めている。この方式は
 * 「外側の変数をうっかり参照した」瞬間に壊れるが、ブラウザで動かすまで
 * 気づきにくい。ここで別の実行文脈に流し込んで、先に捕まえておく。 */
console.log('5) Worker 用に切り出したコードが動くか');

let wsrc = null, werr = null;
try { wsrc = IL.jobs.source(); } catch (e) { werr = e; }
check('Worker ソースを組み立てられる', !werr, werr && werr.message);

if (wsrc) {
  /* 外側の realm の型付き配列をそのまま渡し、ArrayBuffer の食い違いを避ける */
  const wbox = { ImageData, Math, console, JSON, Error, isFinite, Number, Array, Object,
    Float32Array, Float64Array, Uint8ClampedArray, Uint32Array, Int32Array };
  wbox.self = wbox;
  wbox.globalThis = wbox;
  vm.createContext(wbox);

  let lerr = null;
  try { vm.runInContext(wsrc, wbox, { filename: 'worker-blob.js' }); } catch (e) { lerr = e; }
  check('Worker ソースが読み込める', !lerr, lerr && (lerr.message + '\n' + wsrc.slice(0, 400)));
  check('onmessage が生えている', typeof wbox.onmessage === 'function');

  /* 各 op を Worker 側のコードで実行し、メインスレッド側の結果と突き合わせる */
  if (typeof wbox.onmessage === 'function') {
    for (const [id, over] of bandCases) {
      const op = IL.opById[id];
      const p = Object.assign(IL.defaultParams(op), over);
      const step = 17;

      const bands = [];
      wbox.postMessage = (msg) => bands.push(msg);
      const buf = src.data.buffer.slice(0);
      let rerr = null;
      try {
        wbox.onmessage({ data: { op: id, buf, w: W, h: H, p, y0: 0, y1: H, step } });
      } catch (e) { rerr = e; }

      const label = 'Worker 側 ' + id + ' ' + JSON.stringify(over);
      if (rerr) { check(label, false, rerr.message); continue; }

      const bad = bands.filter((b) => !b.ok);
      if (bad.length) { check(label, false, bad[0].msg); continue; }

      /* 帯を貼り合わせて、メインスレッドで1段目を回した結果と比べる
         （Worker は1段ぶんだけ受け持つので、比較も1段ぶん） */
      const got = new ImageData(W, H);
      for (const b of bands) got.data.set(new Uint8ClampedArray(b.out), b.y0 * W * 4);
      const ctx = op.prepare ? op.prepare(src, p) : null;
      const want = op.kernel(src, p, 0, H, ctx);

      check(label + ' の帯が全部そろう', bands[bands.length - 1].last === true &&
            bands.reduce((a, b) => a + (b.y1 - b.y0), 0) === H,
            bands.length + ' 帯');
      check(label + ' がメインスレッドと一致', maxAbsDiff(want, got) === 0,
            '最大差 ' + maxAbsDiff(want, got));

      /* prepare が ctx.report を返す処理は、その中身が最後の帯に乗って戻ること。
         ここが抜けると、画像は出るのに右下の数値だけが空になる */
      if (ctx && ctx.report) {
        const last = bands[bands.length - 1];
        check(label + ' の report が最後の帯に乗る', !!(last && last.report && last.report.rows));
        check(label + ' の report が途中の帯には乗らない',
              bands.slice(0, -1).every((b) => !b.report));
      }
    }
  }
}

console.log('\n' + (fails === 0 ? '全 ' + checks + ' 項目 合格' : fails + ' / ' + checks + ' 項目 失敗'));
process.exit(fails === 0 ? 0 : 1);
