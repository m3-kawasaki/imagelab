/* ImageLab — histogram.js
 * 画面下部の2枚のグラフ。
 *   ・ヒストグラム … 原画を細線、処理後を塗りで重ねる（変化の向きが読める）
 *   ・ラインプロファイル … カーソル行の輝度を左から右へ並べる
 * どちらも「処理が何をしたか」を数値の側から見るための窓。
 */
(function () {
  'use strict';
  var IL = (window.IL = window.IL || {});
  var U = IL.util;

  function prep(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(80, Math.floor(r.width)), h = Math.max(40, Math.floor(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function frame(g, title) {
    g.ctx.fillStyle = '#141821';
    g.ctx.fillRect(0, 0, g.w, g.h);
    g.ctx.strokeStyle = '#2a3242'; g.ctx.lineWidth = 1;
    g.ctx.strokeRect(0.5, 0.5, g.w - 1, g.h - 1);
    g.ctx.fillStyle = '#7d8798';
    g.ctx.font = '11px system-ui, sans-serif';
    g.ctx.fillText(title, 6, 13);
  }

  /* 上位を数個切り捨てた最大値。1本だけ突出した山でグラフが潰れるのを防ぐ */
  function robustMax(arrays) {
    var all = [];
    arrays.forEach(function (a) { for (var i = 0; i < a.length; i++) all.push(a[i]); });
    all.sort(function (x, y) { return y - x; });
    var idx = Math.min(all.length - 1, Math.floor(all.length * 0.004));
    return Math.max(1, all[idx]);
  }

  var Hist = {};

  /* channel: 'y' | 'rgb' */
  Hist.draw = function (canvas, srcImg, dstImg, channel) {
    var g = prep(canvas);
    frame(g, 'ヒストグラム（細線＝原画 / 塗り＝処理後）');
    if (!srcImg) return;

    var pad = { l: 8, r: 8, t: 20, b: 16 };
    var pw = g.w - pad.l - pad.r, ph = g.h - pad.t - pad.b;
    var ctx = g.ctx;

    var hs = U.histogramRGB(srcImg);
    var hd = dstImg ? U.histogramRGB(dstImg) : hs;

    /* 目盛り（0 / 64 / 128 / 192 / 255） */
    ctx.strokeStyle = '#232b39';
    ctx.fillStyle = '#5d677a';
    [0, 64, 128, 192, 255].forEach(function (v) {
      var x = pad.l + pw * v / 255;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      ctx.fillText(String(v), x - (v === 0 ? 0 : 8), g.h - 4);
    });

    var series = (channel === 'rgb')
      ? [{ s: hs.r, d: hd.r, c: '#ff6b6b' }, { s: hs.g, d: hd.g, c: '#5ed17a' }, { s: hs.b, d: hd.b, c: '#6aa9ff' }]
      : [{ s: hs.y, d: hd.y, c: '#d7dde8' }];

    var max = robustMax(series.map(function (x) { return x.d; })
                 .concat(series.map(function (x) { return x.s; })));

    series.forEach(function (sr) {
      /* 処理後：塗り */
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t + ph);
      for (var i = 0; i < 256; i++) {
        var x = pad.l + pw * i / 255;
        var y = pad.t + ph - Math.min(1, sr.d[i] / max) * ph;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(pad.l + pw, pad.t + ph);
      ctx.closePath();
      ctx.globalAlpha = (channel === 'rgb') ? 0.35 : 0.5;
      ctx.fillStyle = sr.c; ctx.fill();
      ctx.globalAlpha = 1;

      /* 原画：細線 */
      ctx.beginPath();
      for (var k = 0; k < 256; k++) {
        var x2 = pad.l + pw * k / 255;
        var y2 = pad.t + ph - Math.min(1, sr.s[k] / max) * ph;
        if (k === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1; ctx.stroke();
    });
  };

  /* カーソル行（画像座標 y）の輝度プロファイル */
  Hist.drawProfile = function (canvas, srcImg, dstImg, cursor) {
    var g = prep(canvas);
    var y = cursor ? cursor.y : -1;
    frame(g, y >= 0 ? ('ラインプロファイル（y = ' + y + ' の行）') : 'ラインプロファイル（画像上にカーソルを置くと表示）');
    if (!srcImg || y < 0) return;

    var pad = { l: 8, r: 8, t: 20, b: 8 };
    var pw = g.w - pad.l - pad.r, ph = g.h - pad.t - pad.b;
    var ctx = g.ctx, w = srcImg.width;

    ctx.strokeStyle = '#232b39';
    [0, 128, 255].forEach(function (v) {
      var yy = pad.t + ph - ph * v / 255;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke();
    });

    function line(img, color, width) {
      var d = img.data, base = y * w * 4;
      ctx.beginPath();
      for (var x = 0; x < w; x++) {
        var j = base + x * 4;
        var v = U.RW * d[j] + U.GW * d[j + 1] + U.BW * d[j + 2];
        var px = pad.l + pw * x / (w - 1 || 1);
        var py = pad.t + ph - ph * v / 255;
        if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    }

    line(srcImg, 'rgba(255,255,255,0.40)', 1);
    if (dstImg) line(dstImg, '#7fd4ff', 1.6);

    /* カーソル列の位置 */
    if (cursor) {
      var cx = pad.l + pw * cursor.x / (w - 1 || 1);
      ctx.strokeStyle = 'rgba(255,90,90,0.8)';
      ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, pad.t + ph); ctx.stroke();
    }
  };

  IL.hist = Hist;
})();
