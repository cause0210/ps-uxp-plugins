/* =============================================================================
 * maskpng.js —— 纯 JS 的 PNG 编码器（生成 ComfyUI 遮罩用）
 *
 * 【为什么需要它】
 *   这台 Photoshop 上所有"创建/修改选区"的 API 都不可用，实测记录：
 *     · batchPlay selectAll        → 命令"<未知的>"当前不可用
 *     · batchPlay set selection    → 命令"设置"当前不可用
 *     · DOM doc.selection.select() → TypeError: is not a function
 *   但"读选区边界"（batchPlay get selection）和"写二进制文件"都正常。
 *   → 所以改为：用 JS 直接算出遮罩 PNG 的字节，绕开所有选区 API。
 *
 * 【为什么用 1 位色深】
 *   遮罩是二值图（白=重绘，黑=保留），8 位要 width*height 字节，
 *   1 位只要 width*height/8 —— 体积小 8 倍。
 *   实测 5568×3712：8 位 19.7 MB / 161 ms  →  1 位 2.5 MB / 14 ms
 *   羽化交给 ComfyUI 的 grow_mask_by 处理（效果更好）。
 *
 * 【为什么不用压缩库】
 *   PNG 的 IDAT 是 zlib 流，而 zlib 允许使用「存储块(stored)」即完全不压缩。
 *   所以纯手写即可，不需要任何第三方库（UXP 里也没有）。
 *
 * 已用 PIL 复检通过：CRC、adler32、包围盒坐标全部正确。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------- CRC32（PNG 每个 chunk 都要） ---------------- */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- adler32（zlib 流尾校验） ---------------- */
  function adler32(bytes) {
    let a = 1, b = 0;
    const MOD = 65521;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % MOD;
      b = (b + a) % MOD;
    }
    return (((b << 16) | a) >>> 0);
  }

  /* ---------------- zlib 存储块封装（不压缩） ---------------- */
  function zlibStore(data) {
    const MAX = 65535;
    const nBlocks = Math.max(1, Math.ceil(data.length / MAX));
    const total = 2 + (nBlocks * 5) + data.length + 4;
    const out = new Uint8Array(total);
    let p = 0;

    out[p++] = 0x78;   // zlib 头
    out[p++] = 0x01;

    let pos = 0, remaining = data.length;
    if (remaining === 0) {
      out[p++] = 1; out[p++] = 0; out[p++] = 0; out[p++] = 0xFF; out[p++] = 0xFF;
    }
    while (remaining > 0) {
      const len = Math.min(MAX, remaining);
      const isFinal = (remaining - len) === 0 ? 1 : 0;
      out[p++] = isFinal;
      out[p++] = len & 0xFF;
      out[p++] = (len >>> 8) & 0xFF;
      const nlen = (~len) & 0xFFFF;
      out[p++] = nlen & 0xFF;
      out[p++] = (nlen >>> 8) & 0xFF;
      out.set(data.subarray(pos, pos + len), p);
      p += len; pos += len; remaining -= len;
    }

    const ad = adler32(data);
    out[p++] = (ad >>> 24) & 0xFF;
    out[p++] = (ad >>> 16) & 0xFF;
    out[p++] = (ad >>> 8) & 0xFF;
    out[p++] = ad & 0xFF;

    return out.subarray(0, p);
  }

  /* ---------------- PNG chunk ---------------- */
  function chunk(type, data) {
    const len = data.length;
    const out = new Uint8Array(12 + len);
    out[0] = (len >>> 24) & 0xFF;
    out[1] = (len >>> 16) & 0xFF;
    out[2] = (len >>> 8) & 0xFF;
    out[3] = len & 0xFF;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const c = crc32(out.subarray(4, 8 + len));
    out[8 + len] = (c >>> 24) & 0xFF;
    out[9 + len] = (c >>> 16) & 0xFF;
    out[10 + len] = (c >>> 8) & 0xFF;
    out[11 + len] = c & 0xFF;
    return out;
  }

  /* ---------------- 通用拼装 ---------------- */
  function assemblePng(ihdr, idat) {
    const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
    let total = 0;
    parts.forEach(function (x) { total += x.length; });
    const png = new Uint8Array(total);
    let p = 0;
    parts.forEach(function (x) { png.set(x, p); p += x.length; });
    return png;
  }

  function makeIhdr(width, height, bitDepth, colorType) {
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xFF; ihdr[1] = (width >>> 16) & 0xFF;
    ihdr[2] = (width >>> 8) & 0xFF;  ihdr[3] = width & 0xFF;
    ihdr[4] = (height >>> 24) & 0xFF; ihdr[5] = (height >>> 16) & 0xFF;
    ihdr[6] = (height >>> 8) & 0xFF;  ihdr[7] = height & 0xFF;
    ihdr[8] = bitDepth; ihdr[9] = colorType;
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return ihdr;
  }

  /* ---------------- 从 PS 读到的原始像素编码 ----------------
   *
   * 用途：配合「纯色图层法」生成遮罩 —— 先用 imaging.getPixels 把 PS 的像素
   *       读出来，再用这里编码成 PNG（不必先存文件再读回来）。
   *
   * PS 给出的 components 可能是 1(灰度) / 3(RGB) / 4(RGBA)。
   * 遮罩只看明暗，所以取 R 通道；RGBA 且 alpha=0 的按黑处理。
   */
  function encodeGrayFromRaw(width, height, raw, components) {
    const rowBytes = width + 1;
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const off = y * rowBytes;
      out[off] = 0;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let v;
        if (components === 1) v = raw[i];
        else {
          const p = i * components;
          v = (components === 4 && raw[p + 3] === 0) ? 0 : raw[p];
        }
        out[off + 1 + x] = v & 0xFF;
      }
    }
    return assemblePng(makeIhdr(width, height, 8, 0), zlibStore(out));
  }

  /**
   * 从原始像素编码为 1 位灰度（体积最小，适合二值遮罩）
   *
   * 【关于 invert 参数】
   *   实测「纯色图层法」读出来的像素是**反的**：
   *     选区形状 = 黑(0)，选区外 = 白(255)
   *   而 ComfyUI 需要：
   *     白 = 要重绘的区域，黑 = 保留
   *   YAO 代码里 _createFillLayersAction(invert) 会追加一条 {_obj:"invert"}，
   *   但实测**无效**（那两层是纯色内容图层，像素是生成的，invert 命令对它们不起作用，
   *   加不加 invert 输出字节完全相同）。
   *   所以极性翻转在自己的编码器里做 —— 简单、可控、必定生效。
   */
  function encode1bitFromRaw(width, height, raw, components, threshold, invert) {
    const th = (threshold === undefined) ? 128 : threshold;
    const rowBytes = 1 + Math.ceil(width / 8);
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const off = y * rowBytes;
      out[off] = 0;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let v;
        if (components === 1) v = raw[i];
        else {
          const p = i * components;
          v = (components === 4 && raw[p + 3] === 0) ? 0 : raw[p];
        }
        if (invert) v = 255 - v;
        if (v >= th) out[off + 1 + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    return assemblePng(makeIhdr(width, height, 1, 0), zlibStore(out));
  }

  /** 从原始像素编码为 8 位灰度（需要保留羽化/灰阶时用） */
  function encodeGrayFromRaw2(width, height, raw, components, invert) {
    const rowBytes = width + 1;
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const off = y * rowBytes;
      out[off] = 0;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let v;
        if (components === 1) v = raw[i];
        else {
          const p = i * components;
          v = (components === 4 && raw[p + 3] === 0) ? 0 : raw[p];
        }
        out[off + 1 + x] = (invert ? (255 - v) : v) & 0xFF;
      }
    }
    return assemblePng(makeIhdr(width, height, 8, 0), zlibStore(out));
  }

  /* ---------------- 1 位灰度 PNG（由矩形生成） ---------------- */
  function encodeMaskPng1bit(width, height, rect) {
    const rowBytes = 1 + Math.ceil(width / 8);
    const raw = new Uint8Array(rowBytes * height);   // 全 0 = 全黑

    const L = Math.max(0, Math.floor(rect.left));
    const T = Math.max(0, Math.floor(rect.top));
    const R = Math.min(width, Math.ceil(rect.right));
    const B = Math.min(height, Math.ceil(rect.bottom));

    for (let y = T; y < B; y++) {
      const off = y * rowBytes;
      raw[off] = 0;                                   // 过滤器：无
      for (let x = L; x < R; x++) {
        raw[off + 1 + (x >> 3)] |= (0x80 >> (x & 7)); // 置位 = 白
      }
    }

    const idat = zlibStore(raw);
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xFF;
    ihdr[1] = (width >>> 16) & 0xFF;
    ihdr[2] = (width >>> 8) & 0xFF;
    ihdr[3] = width & 0xFF;
    ihdr[4] = (height >>> 24) & 0xFF;
    ihdr[5] = (height >>> 16) & 0xFF;
    ihdr[6] = (height >>> 8) & 0xFF;
    ihdr[7] = height & 0xFF;
    ihdr[8] = 1;    // 位深
    ihdr[9] = 0;    // 颜色类型 0 = 灰度
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const cIHDR = chunk('IHDR', ihdr);
    const cIDAT = chunk('IDAT', idat);
    const cIEND = chunk('IEND', new Uint8Array(0));

    const total = sig.length + cIHDR.length + cIDAT.length + cIEND.length;
    const png = new Uint8Array(total);
    let p = 0;
    png.set(sig, p); p += sig.length;
    png.set(cIHDR, p); p += cIHDR.length;
    png.set(cIDAT, p); p += cIDAT.length;
    png.set(cIEND, p);
    return png;
  }

  /* ---------------- 8 位灰度 PNG（备用，需要羽化时用） ---------------- */
  function encodeMaskPng8bit(width, height, rect, featherPx) {
    const f = featherPx || 0;
    const rowBytes = width + 1;
    const raw = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      const off = y * rowBytes;
      raw[off] = 0;
      for (let x = 0; x < width; x++) {
        let v;
        if (f <= 0) {
          v = (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) ? 255 : 0;
        } else {
          const dx = Math.max(rect.left - x, x - (rect.right - 1), 0);
          const dy = Math.max(rect.top - y, y - (rect.bottom - 1), 0);
          const d = Math.sqrt(dx * dx + dy * dy);
          v = d <= 0 ? 255 : (d >= f ? 0 : Math.round(255 * (1 - d / f)));
        }
        raw[off + 1 + x] = v;
      }
    }
    const idat = zlibStore(raw);
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xFF; ihdr[1] = (width >>> 16) & 0xFF;
    ihdr[2] = (width >>> 8) & 0xFF;  ihdr[3] = width & 0xFF;
    ihdr[4] = (height >>> 24) & 0xFF; ihdr[5] = (height >>> 16) & 0xFF;
    ihdr[6] = (height >>> 8) & 0xFF;  ihdr[7] = height & 0xFF;
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
    let total = 0;
    parts.forEach(function (x) { total += x.length; });
    const png = new Uint8Array(total);
    let p = 0;
    parts.forEach(function (x) { png.set(x, p); p += x.length; });
    return png;
  }

  global.RetouchMaskPng = {
    encodeMaskPng1bit: encodeMaskPng1bit,
    encodeMaskPng8bit: encodeMaskPng8bit,
    encodeGrayFromRaw: encodeGrayFromRaw,
    encode1bitFromRaw: encode1bitFromRaw,
    encodeGrayFromRaw2: encodeGrayFromRaw2,
    crc32: crc32,
    adler32: adler32
  };
})(typeof window !== 'undefined' ? window : globalThis);
