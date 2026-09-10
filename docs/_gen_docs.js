/* ImageLab — 解説パネルの文章を書き出す（node docs/_gen_docs.js）
 *
 * 解説の原本は js/ops/*.js の doc フィールド（アプリが実際に表示しているもの）。
 * ここから2つ生成するので、二重管理にならない。
 *
 *   docs/処理解説.md   … 手元で読む用（VS Code のプレビューなど）。ブログ下書きの土台
 *   docs/処理解説.html … 公開ページで読む用。guide.html からリンクしている
 *
 * .md を GitHub Pages に置いても、ブラウザは記号付きの生テキストを出すだけなので、
 * 公開ページの訪問者には HTML 版のほうを見せる（2026-09-10 に追加）。
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

/* ---------------- HTML 版（公開ページ用） ---------------- */

/* doc の文章は生の HTML として流し込む前提で書かれている（アプリの解説パネルと同じ扱い）。
   ただし **強調** だけは Markdown の書き方なので、ここで <strong> に直す。
   同じ変換が js/main.js の emphasize() にもある。 */
function emphasize(s) {
  return String(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
/* 式は等幅で出すだけなので、記号をそのまま見せる */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 見出しへのリンク用。日本語の label をそのまま id にすると URL が読みにくいので op.id を使う */
const anchor = op => 'op-' + op.id;

const h = [];
h.push('<!DOCTYPE html>');
h.push('<html lang="ja">');
h.push('<head>');
h.push('<meta charset="UTF-8">');
h.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
h.push('<title>ImageLab 処理解説</title>');
h.push('<meta name="description" content="ImageLab に入っている' + IL.ops.length +
       'の処理について、原理・式・見どころをまとめた解説。アプリの解説パネルと同じ文章です。">');
h.push('<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Crect width=\'32\' height=\'32\' rx=\'6\' fill=\'%231b1f24\'/%3E%3Crect x=\'6\' y=\'6\' width=\'9\' height=\'9\' fill=\'%23e05c5c\'/%3E%3Crect x=\'17\' y=\'6\' width=\'9\' height=\'9\' fill=\'%235ca8e0\'/%3E%3Crect x=\'6\' y=\'17\' width=\'9\' height=\'9\' fill=\'%235ce08a\'/%3E%3Crect x=\'17\' y=\'17\' width=\'9\' height=\'9\' fill=\'%23e0c95c\'/%3E%3C/svg%3E">');
h.push('<style>');
h.push(`/* このファイルは docs/_gen_docs.js が生成しています。直接編集しないこと。
   配色は css/style.css と guide.html にそろえてあります。 */
:root {
  --bg:#0d1017; --panel:#141821; --panel2:#182030; --line:#263043;
  --text:#dfe5ef; --dim:#8b95a8; --accent:#7fd4ff; --accent-dim:#2b6d8c;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font:15px/1.85 "Segoe UI","Yu Gothic UI",system-ui,sans-serif; }
header { display:flex; align-items:center; gap:18px; flex-wrap:wrap;
  padding:0 16px; min-height:52px; background:linear-gradient(180deg,#182030,#131a26);
  border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
header h1 { margin:0; font-size:17px; letter-spacing:.06em; color:var(--accent); font-weight:600; }
header .sub { color:var(--dim); font-size:13px; }
.btnlink { display:inline-block; text-decoration:none; background:var(--panel2); color:var(--text);
  border:1px solid var(--line); border-radius:5px; padding:6px 12px; font-size:13px; line-height:1.4; }
.btnlink:hover { background:#202a3d; border-color:#35415a; }
.btnlink.primary { background:var(--accent-dim); border-color:#3d8bad; color:#eaf7ff; }
main { max-width:900px; margin:0 auto; padding:8px 20px 80px; }
a { color:var(--accent); }
h2 { font-size:20px; margin:48px 0 8px; padding-bottom:8px;
  border-bottom:1px solid var(--line); color:var(--accent); }
h3 { font-size:17px; margin:36px 0 6px; scroll-margin-top:64px; }
h4 { font-size:14px; margin:20px 0 6px; color:var(--dim); font-weight:600;
  letter-spacing:.04em; }
p { margin:10px 0; }
pre { background:var(--panel2); border:1px solid var(--line); border-radius:5px;
  padding:12px 14px; overflow-x:auto; font-family:Consolas,monospace; font-size:13.5px; line-height:1.7; }
table { border-collapse:collapse; width:100%; margin:12px 0; font-size:13.5px; }
th,td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
th { background:var(--panel2); color:var(--dim); font-weight:600; white-space:nowrap; }
ul { margin:10px 0; padding-left:22px; }
li { margin:7px 0; }
strong { color:var(--accent); }
.lead { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
  border-radius:6px; padding:14px 18px; margin:20px 0; }
.note { color:var(--dim); font-size:13.5px; }
.toc { background:var(--panel); border:1px solid var(--line); border-radius:6px;
  padding:16px 20px; margin:20px 0; }
.toc h2 { margin:0 0 10px; font-size:16px; border:0; padding:0; }
.toc ul { list-style:none; padding:0; margin:0; }
.toc > ul > li { margin:12px 0 0; }
.toc .cat { color:var(--dim); font-size:13px; }
.toc .ops { display:flex; flex-wrap:wrap; gap:8px; margin-top:5px; padding:0; }
.toc .ops li { margin:0; }
.toc .ops a { display:inline-block; text-decoration:none; background:var(--panel2);
  border:1px solid var(--line); border-radius:4px; padding:3px 9px; font-size:13px; }
.toc .ops a:hover { background:#202a3d; }
.top { font-size:12px; }
footer { border-top:1px solid var(--line); margin-top:56px; padding:20px;
  color:var(--dim); font-size:13px; text-align:center; }`);
h.push('</style>');
h.push('</head>');
h.push('<body>');
h.push('');
h.push('<header>');
h.push('  <h1>ImageLab</h1>');
h.push('  <span class="sub">処理解説</span>');
h.push('  <a class="btnlink primary" href="../index.html">← ImageLab を開く</a>');
h.push('  <a class="btnlink" href="../guide.html">使い方</a>');
h.push('</header>');
h.push('');
h.push('<main>');
h.push('');
h.push('<div class="lead">');
h.push('  <strong>ImageLab に入っている' + IL.ops.length + 'の処理について、原理・式・見どころをまとめたものです。</strong><br>');
h.push('  アプリの右側に出る「解説」と同じ文章なので、<strong>触りながら読むなら、アプリを開いたままそちらを見るほうが早い</strong>です。');
h.push('  このページは、通して読みたいときや、あとから探したいときのためのものです。');
h.push('</div>');
h.push('');
h.push('<p class="note">生成日：' + today + '（<code>node docs/_gen_docs.js</code> で <code>js/ops/*.js</code> から自動生成）</p>');
h.push('');

/* 目次 */
h.push('<nav class="toc">');
h.push('<h2>目次</h2>');
h.push('<ul>');
for (const c of IL.categories) {
  const ops = IL.ops.filter(o => o.category === c.id);
  if (!ops.length) continue;
  h.push('  <li><span class="cat">' + c.label + '</span>');
  h.push('    <ul class="ops">');
  for (const op of ops) h.push('      <li><a href="#' + anchor(op) + '">' + op.label + '</a></li>');
  h.push('    </ul>');
  h.push('  </li>');
}
h.push('</ul>');
h.push('</nav>');
h.push('');

cur = null;
for (const op of IL.ops) {
  if (op.category !== cur) {
    cur = op.category;
    h.push('<h2>' + (catLabel[cur] || cur) + '</h2>');
  }
  h.push('<h3 id="' + anchor(op) + '">' + op.label + '</h3>');

  if (op.params.length) {
    h.push('<h4>パラメータ</h4>');
    h.push('<table>');
    h.push('<tr><th>名前</th><th>種類</th><th>既定値</th><th>範囲・選択肢</th></tr>');
    for (const d of op.params) {
      let range = '—';
      if (d.type === 'range') range = `${d.min} 〜 ${d.max}（刻み ${d.step}）`;
      else if (d.type === 'select') range = d.options.map(o => o.label).join(' / ');
      else if (d.type === 'checkbox') range = 'オン / オフ';
      else if (d.type === 'curve') range = '制御点をドラッグして編集';
      else if (d.type === 'spectrum') range = 'スペクトルの上をドラッグして編集';
      const dv = (typeof d.value === 'function') ? '（初期状態）'
               : Array.isArray(d.value) ? JSON.stringify(d.value) : String(d.value);
      h.push('<tr><td>' + d.label + '</td><td>' + d.type + '</td><td>' +
             escapeHtml(dv) + '</td><td>' + range + '</td></tr>');
    }
    h.push('</table>');
  }

  if (op.doc.principle) {
    h.push('<h4>原理</h4>');
    op.doc.principle.split('\n\n').forEach(par => {
      h.push('<p>' + emphasize(par).replace(/\n/g, '<br>') + '</p>');
    });
  }
  if (op.doc.formula) {
    h.push('<h4>式</h4>');
    h.push('<pre>' + escapeHtml(op.doc.formula) + '</pre>');
  }
  if (op.doc.notes && op.doc.notes.length) {
    h.push('<h4>注意点・見どころ</h4>');
    h.push('<ul>');
    op.doc.notes.forEach(n => h.push('<li>' + emphasize(n) + '</li>'));
    h.push('</ul>');
  }
  h.push('<p class="top"><a href="#">▲ 目次へ戻る</a></p>');
  h.push('');
}

h.push('</main>');
h.push('');
h.push('<footer>');
h.push('  ImageLab — MIT ライセンス　／　<a href="../index.html">ImageLab を開く</a>　／　<a href="../guide.html">使い方</a>');
h.push('</footer>');
h.push('');
h.push('</body>');
h.push('</html>');

const dstHtml = path.join(__dirname, '処理解説.html');
fs.writeFileSync(dstHtml, h.join('\n'), 'utf8');
console.log('書き出しました: docs/処理解説.html（' + IL.ops.length + ' 処理 / ' + h.join('\n').length + ' 文字）');
