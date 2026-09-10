/* ImageLab — 解説パネルの文章を Markdown に書き出す（node docs/_gen_docs.js）
 *
 * 解説の原本は js/ops/*.js の doc フィールド（アプリが実際に表示しているもの）。
 * ここから docs/処理解説.md を生成するので、二重管理にならない。
 * ブログ「カモシカのつぶやき」用の下書きは、この出力を土台にする。
 */
'use strict';
const fs = require('fs'), path = require('path');

global.window = {};
global.ImageData = class ImageData {
  constructor(a, b) { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
};

const root = path.join(__dirname, '..');
const opFiles = fs.readdirSync(path.join(root, 'js/ops')).filter(f => f.endsWith('.js'));
(0, eval)(fs.readFileSync(path.join(root, 'js/core.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(root, 'js/fft.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(root, 'js/registry.js'), 'utf8'));
/* index.html に並んでいる順を正としたいので、そちらの <script> 順で読む */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const order = [...html.matchAll(/js\/ops\/([a-z0-9_]+\.js)/g)].map(m => m[1]);
for (const f of order) {
  if (!opFiles.includes(f)) { console.warn('index.html が参照するファイルが無い: ' + f); continue; }
  (0, eval)(fs.readFileSync(path.join(root, 'js/ops', f), 'utf8'));
}
for (const f of opFiles) {
  if (!order.includes(f)) console.warn('index.html から読まれていない op ファイル: ' + f);
}
const IL = global.window.IL;

const catLabel = {};
IL.categories.forEach(c => (catLabel[c.id] = c.label));

const today = new Date().toISOString().slice(0, 10);
const out = [];
out.push('# ImageLab 処理解説');
out.push('');
out.push('生成日：' + today + '（`node docs/_gen_docs.js` で `js/ops/*.js` から自動生成）');
out.push('');
out.push('アプリの解説パネルに表示している文章そのものです。手で直す場合は、');
out.push('このファイルではなく `js/ops/` の各ファイルの `doc` を直してから再生成してください。');
out.push('');
out.push('---');
out.push('');

let cur = null;
for (const op of IL.ops) {
  if (op.category !== cur) {
    cur = op.category;
    out.push('## ' + (catLabel[cur] || cur));
    out.push('');
  }
  out.push('### ' + op.label);
  out.push('');

  if (op.params.length) {
    out.push('**パラメータ**');
    out.push('');
    out.push('| 名前 | 種類 | 既定値 | 範囲・選択肢 |');
    out.push('|---|---|---|---|');
    for (const d of op.params) {
      let range = '—';
      if (d.type === 'range') range = `${d.min} 〜 ${d.max}（刻み ${d.step}）`;
      else if (d.type === 'select') range = d.options.map(o => o.label).join(' / ');
      else if (d.type === 'checkbox') range = 'オン / オフ';
      else if (d.type === 'curve') range = '制御点をドラッグして編集';
      else if (d.type === 'spectrum') range = 'スペクトルの上をドラッグして編集';
      /* 初期値が関数のもの（マスクのように毎回作り直すもの）は中身を出さない */
      const dv = (typeof d.value === 'function') ? '（初期状態）'
               : Array.isArray(d.value) ? JSON.stringify(d.value) : String(d.value);
      out.push(`| ${d.label} | ${d.type} | ${dv} | ${range} |`);
    }
    out.push('');
  }

  if (op.doc.principle) {
    out.push('**原理**');
    out.push('');
    op.doc.principle.split('\n\n').forEach(par => { out.push(par.replace(/\n/g, '  \n')); out.push(''); });
  }
  if (op.doc.formula) {
    out.push('**式**');
    out.push('');
    out.push('```');
    out.push(op.doc.formula);
    out.push('```');
    out.push('');
  }
  if (op.doc.notes && op.doc.notes.length) {
    out.push('**注意点・見どころ**');
    out.push('');
    op.doc.notes.forEach(n => out.push('- ' + n));
    out.push('');
  }
  out.push('---');
  out.push('');
}

const dst = path.join(__dirname, '処理解説.md');
fs.writeFileSync(dst, out.join('\n'), 'utf8');
console.log('書き出しました: docs/処理解説.md（' + IL.ops.length + ' 処理 / ' + out.join('\n').length + ' 文字）');
