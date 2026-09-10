/* ImageLab — viewer.js
 * 中央のビューア。原画と処理後を並べて見せるための道具立て。
 *   ・分割スライダー（左=原画 / 右=処理後）
 *   ・表示モード切り替え（分割 / 処理後 / 原画 / 差分）
 *   ・ルーペ（マウス追従・倍率可変）
 * 画素を正直に見せたいので、拡大時の補間は切ってある（nearest neighbor）。
 */
(function () {
  'use strict';
  var IL = (window.IL = window.IL || {});
  var U = IL.util;

  function offscreen(img) {
    var c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function Viewer(opts) {
    this.wrap = opts.wrap;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.loupe = opts.loupe;
    this.lctx = this.loupe.getContext('2d');
    this.handle = opts.handle;

    this.srcImg = null; this.dstImg = null;
    this.srcCv = null; this.dstCv = null; this.diffCv = null;

    this.mode = 'split';
    this.split = 0.5;
    this.overlay = null;      /* 画像に重ねる見出し（横並び比較のタイル用） */
    this.diffGain = 4;
    this.loupeOn = true;
    this.loupeZoom = 8;
    this.cursor = null;       /* 画像座標 {x, y} */
    this.onCursor = opts.onCursor || function () {};
    this._raf = 0;

    this.layout = { scale: 1, ox: 0, oy: 0, cw: 0, ch: 0 };

    this._bind();
  }

  Viewer.prototype._bind = function () {
    var self = this;

    window.addEventListener('resize', function () { self.render(); });

    this.wrap.addEventListener('pointermove', function (e) {
      var p = self.clientToImage(e.clientX, e.clientY);
      self.cursor = p;
      self.onCursor(p);
      self.drawLoupe(e);
    });
    this.wrap.addEventListener('pointerleave', function () {
      self.cursor = null;
      self.loupe.style.display = 'none';
      self.onCursor(null);
    });

    /* 分割ハンドルのドラッグ */
    var dragging = false;
    this.handle.addEventListener('pointerdown', function (e) {
      dragging = true; self.handle.setPointerCapture(e.pointerId); e.preventDefault();
    });
    this.handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var r = self.canvas.getBoundingClientRect();
      var L = self.layout;
      var x = (e.clientX - r.left - L.ox) / (L.scale * L.iw || 1);
      self.split = U.clamp(x, 0, 1);
      self.render();
    });
    this.handle.addEventListener('pointerup', function (e) {
      dragging = false;
      try { self.handle.releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    });
  };

  Viewer.prototype.setImages = function (src, dst) {
    this.srcImg = src; this.dstImg = dst;
    this.srcCv = src ? offscreen(src) : null;
    this.dstCv = dst ? offscreen(dst) : null;
    this.diffCv = null;
    this.render();
  };

  /* ---------- 逐次プレビュー ---------- */

  /* 計算中の途中経過を見せる準備。まず原画を敷いておき、
     焼き上がった帯で上から順に上書きしていく。
     dstImg は未完成なので伏せておく（差分表示とヒストグラムは終わってから） */
  Viewer.prototype.beginProgressive = function (src) {
    this.srcImg = src; this.dstImg = null;
    this.srcCv = src ? offscreen(src) : null;
    this.dstCv = src ? offscreen(src) : null;
    this.diffCv = null;
    this._requestRender();
  };

  Viewer.prototype.putBand = function (band, y0) {
    if (!this.dstCv) return;
    this.dstCv.getContext('2d').putImageData(band, 0, y0);
    this._requestRender();
  };

  /* 帯はフレームより速く届くことがあるので、描画は1フレームに1回にまとめる */
  Viewer.prototype._requestRender = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.render(); });
  };

  /* 処理結果に重ねる見出し。
     「ノイズ除去の比較」が1枚の中に4面を貼って返すので、どの面が何なのかを
     画像の外から書く。画素そのものを書き換えないので、保存した PNG には入らないし、
     ルーペにも映らない（拡大して見たいのは絵のほうなので、そのほうが都合がよい）。
     tiles は画像座標の [{x, y, w, h, label, sub, best}]。null で消える。 */
  Viewer.prototype.setOverlay = function (tiles) {
    this.overlay = (tiles && tiles.length) ? tiles : null;
    this.render();
  };

  Viewer.prototype.setMode = function (m) { this.mode = m; this.render(); };
  Viewer.prototype.setDiffGain = function (g) { this.diffGain = g; this.diffCv = null; this.render(); };

  Viewer.prototype._diffCanvas = function () {
    if (!this.diffCv && this.srcImg && this.dstImg) {
      this.diffCv = offscreen(U.diffImageData(this.srcImg, this.dstImg, this.diffGain));
    }
    return this.diffCv;
  };

  /* 表示領域に収まる倍率とオフセットを決める */
  Viewer.prototype._layout = function () {
    var rect = this.wrap.getBoundingClientRect();
    var cw = Math.max(64, Math.floor(rect.width)), ch = Math.max(64, Math.floor(rect.height));
    var iw = this.srcImg ? this.srcImg.width : 1, ih = this.srcImg ? this.srcImg.height : 1;
    var scale = Math.min(cw / iw, ch / ih);
    var L = this.layout;
    L.scale = scale; L.iw = iw; L.ih = ih; L.cw = cw; L.ch = ch;
    L.ox = Math.round((cw - iw * scale) / 2);
    L.oy = Math.round((ch - ih * scale) / 2);
    return L;
  };

  Viewer.prototype.clientToImage = function (clientX, clientY) {
    var r = this.canvas.getBoundingClientRect(), L = this.layout;
    var x = Math.floor((clientX - r.left - L.ox) / L.scale);
    var y = Math.floor((clientY - r.top - L.oy) / L.scale);
    if (!this.srcImg) return null;
    if (x < 0 || y < 0 || x >= L.iw || y >= L.ih) return null;
    return { x: x, y: y };
  };

  Viewer.prototype.render = function () {
    if (!this.srcCv) return;
    var L = this._layout();
    var dpr = window.devicePixelRatio || 1;
    var cv = this.canvas, ctx = this.ctx;

    if (cv.width !== Math.round(L.cw * dpr) || cv.height !== Math.round(L.ch * dpr)) {
      cv.width = Math.round(L.cw * dpr); cv.height = Math.round(L.ch * dpr);
    }
    cv.style.width = L.cw + 'px'; cv.style.height = L.ch + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, L.cw, L.ch);

    var dw = L.iw * L.scale, dh = L.ih * L.scale;
    var main = this.dstCv || this.srcCv;
    if (this.mode === 'source') main = this.srcCv;
    if (this.mode === 'diff') main = this._diffCanvas() || this.srcCv;

    ctx.drawImage(main, L.ox, L.oy, dw, dh);

    if (this.mode === 'split') {
      var sx = L.ox + dw * this.split;
      ctx.save();
      ctx.beginPath(); ctx.rect(L.ox, L.oy, Math.max(0, sx - L.ox), dh); ctx.clip();
      ctx.drawImage(this.srcCv, L.ox, L.oy, dw, dh);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx + 0.5, L.oy); ctx.lineTo(sx + 0.5, L.oy + dh); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.moveTo(sx - 0.5, L.oy); ctx.lineTo(sx - 0.5, L.oy + dh); ctx.stroke();
      this._label(ctx, '原画', L.ox + 8, L.oy + 8, sx - L.ox > 56);
      this._label(ctx, '処理後', L.ox + dw - 60, L.oy + 8, L.ox + dw - sx > 64);
      this.handle.style.display = 'block';
      this.handle.style.left = sx + 'px';
      this.handle.style.top = L.oy + 'px';
      this.handle.style.height = dh + 'px';
    } else {
      this.handle.style.display = 'none';
      var name = { result: '処理後', source: '原画', diff: '差分 ×' + this.diffGain }[this.mode];
      this._label(ctx, name, L.ox + 8, L.oy + 8, true);
    }

    /* 見出しは処理結果の上にだけ乗せる。原画側・差分表示では意味がないので出さない */
    if (this.overlay && this.mode !== 'source' && this.mode !== 'diff') {
      ctx.save();
      if (this.mode === 'split') {
        var ox = L.ox + dw * this.split;
        ctx.beginPath();
        ctx.rect(ox, L.oy, Math.max(0, L.ox + dw - ox), dh);
        ctx.clip();
      }
      this.drawOverlay(ctx, L);
      ctx.restore();
    }
  };

  /* タイルの見出しを描く。狭すぎて読めない大きさなら、その面は諦める。
     L は {scale, ox, oy}。保存のときは等倍・原点で呼ばれる（js/main.js の btn-save）。 */
  Viewer.prototype.drawOverlay = function (ctx, L) {
    var s = L.scale;
    this.overlay.forEach(function (t) {
      var tw = t.w * s, th = t.h * s;
      if (tw < 96 || th < 40) return;
      var x = L.ox + t.x * s + 7, y = L.oy + t.y * s + 7;

      ctx.font = 'bold 13px system-ui, sans-serif';
      var w1 = ctx.measureText(t.label).width;
      ctx.font = '11px system-ui, sans-serif';
      var w2 = t.sub ? ctx.measureText(t.sub).width : 0;
      var bw = Math.min(tw - 14, Math.max(w1, w2) + 16);
      var bh = t.sub ? 36 : 22;

      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(x, y, bw, bh);
      if (t.best) {
        /* いちばん成績のよかった面に金色の縦線を立てる */
        ctx.fillStyle = '#f0c040';
        ctx.fillRect(x, y, 3, bh);
      }
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = t.best ? '#ffe08a' : '#fff';
      ctx.fillText(t.label, x + 8, y + 15);
      if (t.sub) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.fillText(t.sub, x + 8, y + 30);
      }
    });
  };

  Viewer.prototype._label = function (ctx, text, x, y, show) {
    if (!show) return;
    ctx.font = '12px system-ui, sans-serif';
    var w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, w, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + 6, y + 14);
  };

  Viewer.prototype.drawLoupe = function (e) {
    if (!this.loupeOn || !this.cursor || !this.srcCv) { this.loupe.style.display = 'none'; return; }
    var size = 160, z = this.loupeZoom, half = size / (2 * z);
    var lp = this.loupe, ctx = this.lctx;
    var dpr = window.devicePixelRatio || 1;
    if (lp.width !== size * dpr) { lp.width = size * dpr; lp.height = size * dpr; }
    lp.style.width = size + 'px'; lp.style.height = size + 'px';
    lp.style.display = 'block';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, size, size);

    var cx = this.cursor.x + 0.5, cy = this.cursor.y + 0.5;
    var sxImg = cx - half, syImg = cy - half, sw = half * 2;

    var main = this.dstCv || this.srcCv;
    if (this.mode === 'source') main = this.srcCv;
    if (this.mode === 'diff') main = this._diffCanvas() || this.srcCv;
    ctx.drawImage(main, sxImg, syImg, sw, sw, 0, 0, size, size);

    if (this.mode === 'split') {
      var splitImgX = this.layout.iw * this.split;
      var cut = (splitImgX - sxImg) * z;
      if (cut > 0) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, Math.min(size, cut), size); ctx.clip();
        ctx.drawImage(this.srcCv, sxImg, syImg, sw, sw, 0, 0, size, size);
        ctx.restore();
        if (cut < size) {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cut, 0); ctx.lineTo(cut, size); ctx.stroke();
        }
      }
    }

    /* 中心の1画素を示す枠 */
    ctx.strokeStyle = 'rgba(255,80,80,0.95)'; ctx.lineWidth = 1;
    ctx.strokeRect(size / 2 - z / 2, size / 2 - z / 2, z, z);

    /* カーソルの反対側に出して、見たい場所を隠さない */
    var wr = this.wrap.getBoundingClientRect();
    var lx = e.clientX - wr.left + 20, ly = e.clientY - wr.top + 20;
    if (lx + size > wr.width) lx = e.clientX - wr.left - size - 20;
    if (ly + size > wr.height) ly = e.clientY - wr.top - size - 20;
    lp.style.left = Math.max(0, lx) + 'px';
    lp.style.top = Math.max(0, ly) + 'px';
  };

  IL.Viewer = Viewer;
})();
