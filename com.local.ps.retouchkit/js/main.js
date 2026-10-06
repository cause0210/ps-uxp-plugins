/* =============================================================================
 * main.js —— 本地修图工具箱（Photoshop UXP 插件核心逻辑）
 *
 * 对应需求：
 *   · 功能1 清除杂物/路人：读取 PS 原生选区 → 本地“内容识别填充 / 移除工具” → 写回原图层
 *   · 功能2 衣物褶皱抚平：表面模糊（选区蒙版）+ 强度混合 → 合并回原图层，保留布料纹理
 *   · 全程在 Photoshop 内部完成，不调用任何第三方远程接口，不联网
 *   · 所有修改都在原文档、原分辨率下进行，不做缩放/重采样，因此绝不压缩图片
 *
 * 代码结构：
 *   §0 依赖与常量
 *   §1 通用工具函数
 *   §2 batchPlay 统一封装
 *   §3 文档 / 图层 / 选区 读取
 *   §4 选区 / 图层 操作
 *   §5 局部修复滤镜（PS 内置）
 *   §6 业务：清除杂物 / 路人
 *   §7 业务：衣物褶皱抚平
 *   §8 参数持久化
 *   §9 UI 装配与事件绑定
 *   §10 启动
 *
 * 说明：Photoshop UXP 面板只支持 main 中声明的单个入口 HTML，
 *       因此这里用单个 IIFE 承载全部逻辑，避免污染全局作用域。
 * ========================================================================== */
(function () {
  'use strict';

  /* ========================================================================
   * §0 依赖与常量
   * ===================================================================== */

  // ---- 依赖加载策略（重要）----
  //
  // 坑记录：一开始这里写的是 `require('./i18n.js')`，
  // 在部分 Photoshop 版本里会直接抛：
  //     Error: Module not found: "./i18n.js". Parent module folder was: "./".
  // 而且这个异常发生在脚本顶层，会导致**整个面板脚本一行都不执行**
  // （表现就是：状态条永远"没有打开文档"、按钮和滑块全部没反应）。
  //
  // 所以现在改成：i18n 由 index.html 里的 <script src="js/i18n.js"> 先行加载，
  // 通过 window.RetouchI18n 全局对象获取，完全不依赖 UXP 的模块解析。
  // 下面仍然保留 require 作为兜底（万一某版本只支持 require 而不支持全局）。
  const photoshop = require('photoshop');

  // ⚠️ 千万不要漏掉 app！
  // 曾经这里写成 `const { core, action } = photoshop;`，漏了 app，
  // 结果 getActiveDoc() 里访问 `app` 抛 ReferenceError，
  // 被 try/catch 吞掉后一律返回 null —— 面板就永远显示"当前没有打开文档"。
  const app = photoshop.app;
  const core = photoshop.core;
  const action = photoshop.action;
  const batchPlay = action.batchPlay;

  // 启动自检：确认这三个核心对象真的拿到了（拿不到就直接在日志里报出来）
  if (!app || !core || !action) {
    throw new Error('UXP 环境异常：photoshop.app / core / action 未能加载（app=' +
      !!app + ', core=' + !!core + ', action=' + !!action + '）');
  }

  function loadI18n() {
    // ① 首选：由 <script> 标签注入的全局对象（最稳，绝不抛错）
    if (typeof window !== 'undefined' && window.RetouchI18n) {
      return window.RetouchI18n;
    }
    // ② 兜底：尝试 require（失败就自己造一个极简实现，保证插件一定能用）
    try {
      const mod = require('./i18n.js');
      if (mod && typeof mod.t === 'function') return mod;
    } catch (e) { /* 忽略：走下面的降级实现 */ }

    // ③ 最后兜底：把中文词表直接内嵌在这里，保证界面绝不出现空白或原始 key。
    //    完整词表在 js/i18n.js 里（已内联），正常情况走不到这个分支。
    const FALLBACK = {
      "app.title": "本地修图工具箱",
      "app.subtitle": "100% 本地处理 · 不压缩分辨率",
      "status.noDocument": "当前没有打开文档",
      "status.size": "尺寸",
      "status.resolution": "分辨率",
      "status.selection": "选区",
      "status.noSelection": "无",
      "status.hasSelection": "有",
      "status.untitled": "未命名文档",
      "btn.refresh": "刷新状态",
      "btn.working": "处理中…",
      "remove.title": "清除杂物 / 路人",
      "remove.desc": "读取 PS 原生选区，调用本地“内容识别填充 / 移除工具”算法，自动取样周围像素完成修复并直接写入原图层。",
      "remove.btn": "清除杂物 / 路人",
      "remove.btn2": "用修复画笔再补一刀（可选）",
      "remove.hint": "选区要稍微多框住物体外沿 2~5 像素，内容识别填充的效果最好。",
      "smooth.title": "衣物褶皱抚平",
      "smooth.desc": "表面模糊只抹平低频明暗起伏（褶皱），保留高频布料纹理；再把模糊结果与原始信息按强度混合，避免糊化。全程以选区做蒙版，不产生生硬边界。",
      "smooth.radius": "模糊半径（px）",
      "smooth.radiusTip": "褶皱宽度大约是多少像素就填多少；分辨率越高数值越大。",
      "smooth.threshold": "边缘阈值（保纹理）",
      "smooth.thresholdTip": "阈值越小越保留纹理、越不糊；想更强力可以降到 6~10。",
      "smooth.strength": "修复强度（%）",
      "smooth.strengthTip": "100% 等于完全使用模糊结果；60%~80% 通常既平褶皱又留纹理。",
      "smooth.btn": "抚平衣物褶皱",
      "smooth.advanced": "高级：模糊算法与边缘羽化",
      "smooth.filter": "模糊算法",
      "smooth.filter.surface": "表面模糊（推荐）",
      "smooth.filter.smart": "特殊模糊",
      "smooth.filter.median": "蒙尘与划痕 / 中值",
      "smooth.filterTip": "中值对细小布料纹理保护最好，但速度较慢。",
      "smooth.feather": "选区羽化（px）",
      "smooth.featherTip": "大于 0 时会在选区边缘做渐变过渡，避免修复痕迹出现硬边。",
      "log.title": "运行日志",
      "log.clear": "清空",
      "log.ready": "插件已就绪，等待操作。",
      "log.env": "运行环境：Photoshop UXP · 全部处理均在本地完成，不联网、不上传图片。",
      "log.moduleFail": "UXP 模块加载异常，请确认 Photoshop 版本 ≥ 24.4 且插件已正确加载。",
      "log.langSwitched": "界面语言已切换",
      "opt.keep": "记住参数",
      "msg.refreshed": "状态已刷新",
      "msg.busyWait": "正在处理中，请稍候…",
      "msg.noDocument": "当前没有打开的文档，请先在 Photoshop 中打开一张图片。",
      "msg.noSelection": "没有检测到选区。请先用 PS 自带选区工具（矩形/套索/快速选择）框选要处理的区域。",
      "msg.needOneLayer": "当前图层不支持像素级修复（智能对象 / 文字 / 形状 / 调整层 / 图层组被锁定）。请先栅格化该图层，或换一个普通像素图层再执行。",
      "msg.badSelection": "选区太小或无效，请重新框选。",
      "msg.psBusy": "Photoshop 正忙（可能弹出了对话框），请先按 Esc 关闭弹窗后重试。",
      "msg.repairing": "正在使用本地算法修复…",
      "msg.removeOk": "杂物/路人已清除，已写回原图层。",
      "msg.healOk": "修复画笔辅助修补完成。",
      "msg.healNoSelection": "没有选区，修复画笔未执行。",
      "msg.smoothOk": "衣物褶皱已抚平（选区已作为蒙版），纹理保留。",
      "msg.workedOk": "处理完成。",
      "msg.failed": "处理失败。",
      "msg.undoHint": "不满意可按 Ctrl+Z 撤销，或调整参数后重试。",
      "msg.docNotOpen": "找不到活动文档，操作已取消。",
      "msg.resOk": "分辨率保持不变：",
      "msg.selArea": "选区边界",
      "msg.layer": "图层"
    };
    return {
      t: function (key, fb) {
        if (FALLBACK[key]) return FALLBACK[key];
        return typeof fb === 'string' ? fb : key;
      },
      init: function () { return Promise.resolve('zh_CN'); },
      applyDom: function () {},
      setLang: function () { return 'zh_CN'; },
      getLang: function () { return 'zh_CN'; },
      isReady: function () { return false; }
    };
  }

  const i18n = loadI18n();
  const t = function (key, fallback) { return i18n.t(key, fallback); };

  /** 内容识别填充的本地菜单命令 ID（各语言版本下 ID 一致） */
  const MENU_CONTENT_AWARE_FILL = 'contentAwareFill';

  /** 可调参数默认值（同时作为“记住参数”的兜底） */
  const CONFIG = {
    radius: 8,               // 表面模糊半径（px）
    threshold: 16,           // 表面模糊边缘阈值
    strength: 70,            // 混合强度 %
    filterName: 'surfaceBlur',
    feather: 0,              // 选区羽化（px）
    keepSettings: true
  };

  /* ========================================================================
   * §1 通用工具函数
   * ===================================================================== */

  function $(id) {
    return document.getElementById(id);
  }

  /** 浅拷贝，用于安全复制 batchPlay 描述符 */
  function clone(obj) {
    const out = {};
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
  }

  function num(v, fallback) {
    const n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** 取出错误里的可读文本（不抛错、不递归） */
  function rawErrorText(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    try {
      if (typeof e.message === 'string' && e.message) return e.message;
      if (typeof e.number !== 'undefined' && e.number !== null) return String(e.number);
      if (typeof e.name === 'string' && e.name) return e.name;
    } catch (err) { /* 忽略 */ }
    return '';
  }

  /**
   * 判断某个错误是不是“描述符字段不被支持”引起的。
   * 只有这类错误才允许把命令去掉 _options 重试一次，
   * 避免“命令其实已经生效、只是后续字段报错”时被重复执行。
   */
  function looksLikeOptionError(e) {
    const s = rawErrorText(e).toLowerCase();
    if (!s) return false;
    return s.indexOf('options') >= 0 ||
      s.indexOf('dialog') >= 0 ||
      s.indexOf('not supported') >= 0 ||
      s.indexOf('unsupported') >= 0 ||
      s.indexOf('illegal argument') >= 0 ||
      s.indexOf('unknown key') >= 0 ||
      s.indexOf('unexpected') >= 0 ||
      s.indexOf('invalid') >= 0 ||
      s.indexOf('-4') >= 0;
  }

  /** 把任意错误对象转成可读文本 */
  function errorText(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    return err.message || err.number || err.name || String(err);
  }

  /** 保证在模组化执行作用域内运行（UXP 修改文档的强制要求） */
  async function modal(fn) {
    return core.executeAsModal(fn, { commandName: '本地修图工具箱' });
  }

  /* ========================================================================
   * §2 batchPlay 统一封装
   * ===================================================================== */

  /**
   * 执行 batchPlay（只用于**修改类**命令；读取一律走 DOM API，见 §3）。
   *
   * 【重要教训】本插件最初用 `{ _obj: 'get', ... }` 来读文档/图层/选区，
   * 结果 Photoshop 直接报错：**命令"获取"当前不可用**。
   * 原因：batchPlay 里根本没有 `get` 这个命令名（那是 ExtendScript DOM 的方法名）。
   * 参照同环境下可正常工作的 YAO 插件，正确做法是：
   *   · 读取 → 用 `require('photoshop').app` 的 DOM API（activeDocument / selection.bounds …）
   *   · 修改 → 用 batchPlay，并且 options 里带上 `synchronousExecution: true`
   *
   * 参数：
   *   commands —— 单个描述符或描述符数组
   *   useDialogOptions —— 是否给命令加 dialogOptions: 'dontDisplay'（默认加，避免弹参数框）
   */
  async function bp(commands, useDialogOptions) {
    const list = Array.isArray(commands) ? commands : [commands];
    const withDialog = useDialogOptions !== false;

    const prepared = list.map(function (c) {
      const cmd = clone(c);
      if (withDialog) {
        cmd._options = Object.assign({ dialogOptions: 'dontDisplay' }, c._options || {});
      }
      return cmd;
    });

    // synchronousExecution 是 YAO 插件里验证可用的写法，必须带上
    const options = { synchronousExecution: true };

    try {
      const res = await batchPlay(prepared, options);
      return res.length === 1 ? res[0] : res;
    } catch (e) {
      if (!looksLikeOptionError(e)) throw e;
      // 极老版本不认某些字段时，去掉 _options 再试一次
      const plain = list.map(function (c) { return clone(c); });
      const res = await batchPlay(plain, options);
      return res.length === 1 ? res[0] : res;
    }
  }

  /* ========================================================================
   * §3 文档 / 图层 / 选区 读取（**全部走 UXP DOM API，不用 batchPlay**）
   *
   * 为什么不用 batchPlay 读？
   *   最初这里写的是 `batchPlay([{ _obj: 'get', _target: [...] }])`，
   *   Photoshop 直接报 **命令"获取"当前不可用** —— batchPlay 里没有 `get` 命令。
   *   同环境下正常工作的 YAO 插件，读数据全部用 DOM API：
   *       app.activeDocument.selection.bounds
   *       app.activeDocument.activeLayer.id
   *       app.documents.find(d => d.id === xxx)
   *   所以这里统一改成 DOM API，batchPlay 只留给"修改类"命令。
   * ===================================================================== */

  /**
   * 拿当前活动文档对象。没有打开文档时**返回 null**（不抛错）。
   */
  function getActiveDoc() {
    try {
      const d = app.activeDocument;
      return d || null;
    } catch (e) {
      // 没有打开的文档时，访问 activeDocument 会抛错，这里视为 null
      return null;
    }
  }

  /** 安全读取文档的某个属性；读不到返回 fallback，绝不抛错 */
  function safeProp(obj, path, fallback) {
    try {
      let cur = obj;
      const parts = String(path).split('.');
      for (let i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined) return fallback;
        cur = cur[parts[i]];
      }
      return (cur === undefined || cur === null) ? fallback : cur;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * 读取当前活动文档的基础信息（纯 DOM API）。
   * 返回的 signature 是“分辨率指纹”，处理后用于回验图片没有被改变尺寸。
   */
  async function getDocInfo() {
    const doc = getActiveDoc();

    if (!doc) {
      return {
        id: null, name: t('status.noDocument'),
        width: null, height: null, dpi: null, mode: null,
        numberOfLayers: null, signature: '0x0@0'
      };
    }

    // UXP 里 doc.width / doc.height 直接就是像素数
    let width = Math.round(num(safeProp(doc, 'width', 0), 0)) || null;
    let height = Math.round(num(safeProp(doc, 'height', 0), 0)) || null;
    let dpi = Math.round(num(safeProp(doc, 'resolution', 0), 0)) || null;
    let numberOfLayers = Math.round(num(safeProp(doc, 'layers.length', 0), 0)) || null;

    // 宽高万一读不到，退一步用当前图层的边界推算
    if (!width || !height) {
      try {
        const b = doc.activeLayer && doc.activeLayer.bounds ? doc.activeLayer.bounds : null;
        if (b) {
          width = width || Math.round(Math.abs(num(b.right, 0) - num(b.left, 0)));
          height = height || Math.round(Math.abs(num(b.bottom, 0) - num(b.top, 0)));
        }
      } catch (e) { /* 忽略 */ }
    }

    const mode = (function () {
      try {
        const m = doc.mode;
        if (m === null || m === undefined) return null;
        return String(m._value || m);
      } catch (e) { return null; }
    })();

    return {
      id: safeProp(doc, 'id', null),
      name: String(safeProp(doc, 'title', t('status.untitled'))),
      width: width,
      height: height,
      dpi: dpi,
      mode: mode,
      numberOfLayers: numberOfLayers,
      signature: (width || 0) + 'x' + (height || 0) + '@' + (dpi || 0)
    };
  }

  /**
   * 读取当前图层的信息（纯 DOM API）。
   * kind 用来判断能否直接做像素级修复（智能对象 / 文字 / 形状等要提前拦下）。
   */
  async function getActiveLayerInfo() {
    const doc = getActiveDoc();
    if (!doc) {
      return { name: '-', id: null, opacity: 100, kind: null, locked: false, background: false };
    }

    let layer = null;
    try {
      layer = doc.activeLayer || null;
    } catch (e) {
      layer = null;
    }

    if (!layer) {
      return { name: '-', id: null, opacity: 100, kind: null, locked: false, background: false };
    }

    // kind 在新版里是字符串（如 'smartObject' / 'normal' / 'background'）
    let kind = null;
    try {
      const k = layer.kind;
      kind = (k && typeof k === 'object') ? (k._value || null) : (k || null);
      if (kind) kind = String(kind);
    } catch (e) { kind = null; }

    // 背景层：新版 PS 里 kind 可能报 'background'，也可能是名字叫“背景”
    const isBackground = (kind === 'background') ||
      (function () {
        try { return !!layer.isBackgroundLayer; } catch (e) { return false; }
      })();

    let locked = false;
    try { locked = !!layer.locked; } catch (e) { locked = false; }

    return {
      name: String(safeProp(layer, 'name', '图层')),
      id: safeProp(layer, 'id', null),
      opacity: num(safeProp(layer, 'opacity', 100), 100),
      kind: kind,
      locked: locked,
      /** 背景层本身“被锁定”，但内容识别填充 / 滤镜都可以直接作用在它上面 */
      background: isBackground
    };
  }

  /**
   * 读取当前选区（纯 DOM API）。
   *
   * 判据来自同环境下可正常工作的 YAO 插件：
   *     const b = app.activeDocument.selection.bounds;
   *     return b && b.left !== b.right && b.top !== b.bottom;
   * `selection.bounds` 在“没有选区”时是 null。
   */
  async function getSelectionInfo() {
    const empty = {
      hasSelection: false, count: 0, bounds: null, width: 0, height: 0, tooSmall: false
    };

    const doc = getActiveDoc();
    if (!doc) return empty;

    let bounds = null;
    try {
      bounds = doc.selection ? doc.selection.bounds : null;
    } catch (e) {
      bounds = null;
    }

    if (!bounds) return empty;

    const left = num(bounds.left, NaN);
    const top = num(bounds.top, NaN);
    const right = num(bounds.right, NaN);
    const bottom = num(bounds.bottom, NaN);

    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) {
      return empty;
    }

    const w = Math.abs(right - left);
    const h = Math.abs(bottom - top);

    // 完全退化成一个点/一条线，视为没有有效选区
    if (w <= 0 || h <= 0) return empty;

    return {
      hasSelection: true,
      count: 1,
      bounds: { top: top, left: left, bottom: bottom, right: right },
      width: Math.round(w),
      height: Math.round(h),
      tooSmall: w < 2 || h < 2
    };
  }

  /* ========================================================================
   * §4 选区 / 工具 操作
   * ===================================================================== */

  /** 取消选区 */
  function deselect() {
    return bp({ _obj: 'deselect', _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }] });
  }

  /** 把活动工具切到“修复画笔”（工具 ID 在各语言版本下一致） */
  function selectHealingBrushTool() {
    return bp({ _obj: 'select', _target: [{ _ref: 'tool', _id: 'healingBrushTool' }] });
  }

  /* ========================================================================
   * §5 局部修复滤镜（全部是 PS 内置滤镜，纯本地运算）
   * ===================================================================== */

  /**
   * 给命令挂上选区限制。
   * 关键点：`selection` 字段让滤镜只在选区内生效，
   * 这样“模糊后的修复结果”与“选区外原始像素”天然形成一张蒙版，
   * 后续把两者合并即可得到“只抚平选区、边缘无硬边”的效果。
   */
  function withSelection(cmd, useSelection) {
    const out = {
      _obj: cmd._obj,
      _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
      _options: { dialogOptions: 'dontDisplay' }
    };
    if (useSelection) {
      out.selection = { _ref: 'channel', _enum: 'channel', _value: 'selection' };
    }
    for (const k in cmd) {
      if (k === '_obj' || k === '_target' || k === '_options') continue;
      if (cmd[k] === undefined) continue;
      out[k] = cmd[k];
    }
    return out;
  }

  /** 表面模糊：radius + threshold，抚平褶皱又保纹理的核心滤镜 */
  function applySurfaceBlur(radius, threshold, useSelection) {
    return bp(withSelection({
      _obj: 'surfaceBlur',
      radius: { _unit: 'pixelsUnit', _value: clamp(Math.round(num(radius, 8)), 1, 100) },
      threshold: { _unit: 'pixelsUnit', _value: clamp(Math.round(num(threshold, 16)), 0, 255) }
    }, useSelection));
  }

  /** 特殊模糊：按阈值保护边缘 */
  function applySmartBlur(radius, threshold, useSelection) {
    return bp(withSelection({
      _obj: 'smartBlur',
      radius: { _unit: 'pixelsUnit', _value: clamp(num(radius, 8), 0.1, 100) },
      threshold: { _unit: 'pixelsUnit', _value: clamp(num(threshold, 16), 0.1, 100) },
      quality: { _enum: 'smartBlurQuality', _value: 'high' },
      mode: { _enum: 'smartBlurMode', _value: 'normal' }
    }, useSelection));
  }

  /** 蒙尘与划痕（中值类）：对细小布料纹理破坏最小 */
  function applyDustAndScratches(radius, threshold, useSelection) {
    return bp(withSelection({
      _obj: 'dustAndScratches',
      radius: { _unit: 'pixelsUnit', _value: clamp(Math.round(num(radius, 8)), 1, 100) },
      threshold: { _unit: 'pixelsUnit', _value: clamp(Math.round(num(threshold, 16)), 0, 255) }
    }, useSelection));
  }

  /** 按用户选择的算法执行模糊 */
  function applyBlur(name, radius, threshold, useSelection) {
    if (name === 'smartBlur') return applySmartBlur(radius, threshold, useSelection);
    if (name === 'median') return applyDustAndScratches(radius, threshold, useSelection);
    return applySurfaceBlur(radius, threshold, useSelection);
  }

  /** 选区羽化（0 表示不羽化） */
  async function featherSelection(px) {
    const value = Math.round(num(px, 0));
    if (value <= 0) return;
    await bp({
      _obj: 'feather',
      radius: { _unit: 'pixelsUnit', _value: value },
      _target: [{ _ref: 'channel', _enum: 'channel', _value: 'selection' }]
    });
  }

  /* ========================================================================
   * §6 业务：清除杂物 / 路人（功能 1）
   * ===================================================================== */

  /**
   * 前置检查：
   *  ① Photoshop 是否正忙（有对话框挡住）
   *  ② 是否打开了文档
   *  ③ 是否存在有效选区
   *  ④ 当前图层能否被直接修改
   * 任何一项不满足都会抛出带 i18n 文案的错误，由上层统一提示。
   */
  async function preflight(options) {
    const opts = options || {};

    // ① PS 是否被对话框阻塞（有弹窗时所有 batchPlay 都会失败，提前给出可读提示）
    try {
      if (typeof core.isModal === 'function' && core.isModal()) {
        const busy = new Error(t('msg.psBusy'));
        busy.rtkHandled = true; // 标记为已处理过的业务错误，避免二次包装
        throw busy;
      }
    } catch (e) {
      if (e && e.rtkHandled) throw e;
      // isModal 本身不可用时忽略
    }

    // ② 是否打开了文档
    const doc = await getDocInfo();
    if (!doc.id) {
      throw new Error(t('msg.noDocument'));
    }

    // ③ 是否存在有效选区
    const sel = await getSelectionInfo();
    if (!sel.hasSelection) {
      throw new Error(t('msg.noSelection'));
    }
    if (sel.tooSmall) {
      throw new Error(t('msg.badSelection'));
    }

    // ④ 当前图层能否被直接修改
    //    背景层的 locked 默认为 true，但内容识别填充与滤镜都可以直接作用于它，
    //    所以这里把背景层放行，只拦截真正不能做像素修改的图层。
    const layer = await getActiveLayerInfo();
    if (opts.needPixelLayer) {
      const blockedKind = layer.kind === 'smartObject' ||
        layer.kind === 'text' ||
        layer.kind === 'solidColorLayer' ||
        layer.kind === 'adjustmentLayer' ||
        layer.kind === 'group';
      if (blockedKind) {
        throw new Error(t('msg.needOneLayer'));
      }
      if (layer.locked && !layer.background) {
        throw new Error(t('msg.needOneLayer'));
      }
    }

    return { doc: doc, selection: sel, layer: layer };
  }

  /**
   * 功能 1：清除杂物 / 路人
   *
   * 实现思路（全部为 PS 本地能力，不联网、不上传图片）：
   *   1. 先把选区做轻微羽化，消灭硬边接缝；
   *   2. 调用 PS 内置的“内容识别填充”（编辑 > 内容识别填充，菜单 ID = contentAwareFill），
   *      由 PS 自己的算法从选区周围取样重建像素，产生的新像素直接写回当前图层；
   *   3. 校验文档尺寸与分辨率是否与处理前完全一致（保证不压缩图片）。
   *
   * 说明：老版本 PS 若没有该菜单项，会抛出可读错误并引导用户改用插件里的
   *      “修复画笔”按钮手动完成，而不是悄悄用低质量算法糊过去。
   */
  async function removeDistraction() {
    return modal(async function () {
      const ctx = await preflight({ needPixelLayer: true });
      log(t('msg.repairing') + ' 选区 ' + ctx.selection.width + '×' + ctx.selection.height + ' px' +
        ' / 图层「' + ctx.layer.name + '」', 'info');

      // 选区羽化：让填充区域的接缝柔和（只影响选区羽化程度，不改变像素尺寸）
      await featherSelection(CONFIG.feather);

      // ---- 调用 PS 本地“内容识别填充” ----
      try {
        await bp({
          _obj: 'menuItemClass',
          menuItem: MENU_CONTENT_AWARE_FILL,
          _target: [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }]
        });
      } catch (e) {
        const detail = errorText(e);
        log('内容识别填充调用失败：' + detail, 'error');
        throw new Error(
          '无法调用 PS 内置的“内容识别填充”（' + detail + '）。' +
          '请确认 Photoshop 版本 ≥ 24.4，且当前文档为 8/16 位 RGB；' +
          '也可以点下方的“用修复画笔再补一刀”手动完成。'
        );
      }

      // 收尾：取消选区，便于用户立刻查看修复结果
      await deselect();

      // ---- 校验：分辨率必须与处理前完全一致 ----
      const after = await getDocInfo();
      verifyResolution(ctx.doc, after);

      return { engine: 'contentAwareFill', doc: after, layerName: ctx.layer.name };
    });
  }

  /**
   * 功能 1 的补充：把当前工具切到“修复画笔”，
   * 让用户在内容识别填充之后手工描几笔处理残留。
   * 只是切换工具，不会改动任何像素。
   *
   * 注意：切工具的命令在各版本里字段不完全一致，所以失败也不报错，
   * 只提示用户按快捷键 J 手动切过去即可，绝不让这一步打断整个流程。
   */
  async function prepareHealingBrush() {
    return modal(async function () {
      const sel = await getSelectionInfo();
      if (!sel.hasSelection) {
        throw new Error(t('msg.noSelection'));
      }

      let switched = false;
      try {
        await selectHealingBrushTool();
        switched = true;
      } catch (e) {
        log('自动切换修复画笔失败（' + errorText(e) + '），请按快捷键 J 手动切换。', 'warn');
      }

      return { selection: sel, switched: switched };
    });
  }

  /* ========================================================================
   * §7 业务：衣物褶皱抚平（功能 2）
   * ===================================================================== */

  /**
   * 功能 2：衣物褶皱抚平
   *
   * 为什么不用“直接无脑模糊”？
   *   整层模糊会不可逆地丢掉布料纹理，容易糊成塑料感。
   * 这里采用 **“选区内滤镜 + 渐隐混合”** 的稳妥做法，全程不新建可见图层：
   *
   *   1. 按“选区羽化”参数软化选区边缘；
   *   2. 在“仍有选区”的状态下对**当前原图层**执行模糊滤镜（表面模糊 / 特殊模糊 / 中值）：
   *      滤镜描述符里带上 selection 字段后，只在选区内部生效，
   *      选区外的像素一点都不动 → 天然形成一张“只修选区”的蒙版；
   *   3. 立刻调用“编辑 > 渐隐（Fade）”按“修复强度”回落混合比例：
   *      strength = 70% 表示保留七成模糊结果、三成原始像素，
   *      既压平了褶皱的低频起伏，又把布料的编纹/针织纹理留在画面里；
   *   4. 取消选区；
   *   5. 校验文档尺寸与 DPI 与处理前完全一致（保证不压缩图片）。
   *
   * 相比“新建层 → 复制 → 模糊 → 改不透明度 → 合并”，这条路径：
   *   · 不产生任何临时文档 / 临时图层；
   *   · 不会重命名或改变用户图层结构；
   *   · 失败时只需一次 Ctrl+Z 就能干净回滚。
   */
  async function smoothWrinkles(settings) {
    const cfg = Object.assign({}, CONFIG, settings || {});

    return modal(async function () {
      // 前置检查（褶皱平滑要求当前图层是普通像素层）
      const ctx = await preflight({ needPixelLayer: true });
      const docInfo = ctx.doc;
      const targetLayer = ctx.layer;

      const radius = clamp(Math.round(num(cfg.radius, CONFIG.radius)), 1, 100);
      const threshold = clamp(Math.round(num(cfg.threshold, CONFIG.threshold)), 0, 255);
      const strength = clamp(Math.round(num(cfg.strength, CONFIG.strength)), 1, 100);
      const feather = clamp(Math.round(num(cfg.feather, CONFIG.feather)), 0, 200);

      log('褶皱抚平：半径 ' + radius + 'px / 阈值 ' + threshold +
        ' / 强度 ' + strength + '% / 算法 ' + cfg.filterName +
        ' / 图层「' + targetLayer.name + '」', 'info');

      // ① 选区羽化：让修复区域与周围平滑过渡，不出现硬边补丁
      await featherSelection(feather);

      // ② 在选区内执行模糊（只作用于当前原图层，选区外像素保持原样）
      await applyBlur(cfg.filterName, radius, threshold, true);

      // ③ 渐隐混合：控制“抹平程度”，数值越低越保留原始质感
      if (strength < 100) {
        try {
          await bp({
            _obj: 'fade',
            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'selection' }],
            to: { _obj: 'opacity', _unit: 'percentUnit', _value: strength }
          });
        } catch (e) {
          // 极少数版本不支持 fade 命令时的兜底：用一次表面模糊的记录做渐隐
          log('渐隐命令不可用（' + errorText(e) + '），本次按 100% 强度输出。', 'warn');
        }
      }

      // ④ 收尾：取消选区，方便用户立刻查看修复结果
      await deselect();

      // ⑤ 校验分辨率
      const after = await getDocInfo();
      verifyResolution(docInfo, after);

      return {
        filterName: cfg.filterName,
        radius: radius,
        threshold: threshold,
        strength: strength,
        layerName: targetLayer.name,
        doc: after
      };
    });
  }

  /**
   * 分辨率一致性校验。
   * 这是需求“保持原始分辨率不变、不能压缩图片”的硬性保障：
   * 处理前后像素尺寸与 DPI 必须完全一致，否则直接抛出错误提醒用户。
   */
  function verifyResolution(before, after) {
    if (!before || !after) return;
    if (before.signature !== after.signature) {
      throw new Error(
        '分辨率发生变化（' + before.signature + ' → ' + after.signature + '），' +
        '操作已中止，请按 Ctrl+Z 撤销后检查文档设置。'
      );
    }
  }

  /* ========================================================================
   * §8 参数持久化（保存在 PS 的用户数据目录，纯本地文件，不联网）
   * ===================================================================== */

  const SETTINGS_FILE = 'retouch-kit-settings.json';
  const STATE_KEY = 'rtk.state';

  /** 极简状态存储（仅保存最后一次的参数与语言，兼作设置文件不可用时的兜底） */
  const stateStore = {
    save: function (data) {
      try {
        window.localStorage.setItem(STATE_KEY, JSON.stringify(data));
      } catch (e) { /* 忽略 */ }
    },
    load: function () {
      try {
        const raw = window.localStorage.getItem(STATE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }
  };

  function settingsFileName() {
    return SETTINGS_FILE;
  }

  async function loadSettings() {
    // 优先读 localStorage（快），再尝试读用户数据目录里的 JSON（可跨面板重置保留）
    const local = stateStore.load();
    if (local) {
      Object.keys(CONFIG).forEach(function (k) {
        if (local[k] !== undefined && local[k] !== null) CONFIG[k] = local[k];
      });
    }

    try {
      const fs = require('uxp').storage.localFileSystem;
      const folder = await fs.getDataFolder();
      const file = await folder.getEntry(settingsFileName());
      const raw = await file.read();
      const data = JSON.parse(raw);
      Object.keys(CONFIG).forEach(function (k) {
        if (data && data[k] !== undefined && data[k] !== null) CONFIG[k] = data[k];
      });
    } catch (e) {
      // 首次运行或文件不存在：沿用默认值 / localStorage 里的值
    }
    return CONFIG;
  }

  async function saveSettings() {
    stateStore.save(CONFIG);
    try {
      const fs = require('uxp').storage.localFileSystem;
      const folder = await fs.getDataFolder();
      const file = await folder.createFile(settingsFileName(), { overwrite: true });
      await file.write(JSON.stringify(CONFIG, null, 2));
    } catch (e) {
      // 写文件失败不影响主流程：localStorage 已经存了一份
    }
  }

  /* ========================================================================
   * §9 UI 装配与事件绑定
   * ===================================================================== */

  const LOG_MAX = 200;

  /** 写一条运行日志（同时输出到 UXP 控制台，便于排查） */
  function log(msg, level) {
    const text = String(msg);
    const lvl = level || 'info';
    try {
      if (lvl === 'error') console.error('[修图工具箱]', text);
      else if (lvl === 'warn') console.warn('[修图工具箱]', text);
      else console.log('[修图工具箱]', text);
    } catch (e) { /* 忽略 */ }

    const box = $('log');
    if (!box) return;

    const line = document.createElement('div');
    line.className = 'log-line ' + lvl;

    const time = document.createElement('span');
    time.className = 'log-time';
    const d = new Date();
    time.textContent =
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');

    const body = document.createElement('span');
    body.className = 'log-msg';
    body.textContent = text;

    line.appendChild(time);
    line.appendChild(body);
    box.appendChild(line);

    while (box.children.length > LOG_MAX) {
      box.removeChild(box.firstChild);
    }
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = $('log');
    if (box) box.innerHTML = '';
  }

  /**
   * 轻提示浮层。
   * 需求要求“没有选区时弹窗提示用户先画选区”：这里用面板内浮层 + 日志双重提示。
   * 不用原生 alert() 的原因：原生弹窗会阻塞 PS 主线程，反而容易导致脚本超时。
   */
  let toastTimer = null;
  function toast(msg, type) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show ' + (type || 'info');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast ' + (type || 'info');
    }, 2800);
  }

  /** 统一错误处理：给出提示 + 日志 */
  function reportError(prefix, err) {
    const text = errorText(err);
    log((prefix ? prefix + '：' : '') + text, 'error');
    toast(prefix ? prefix + '：' + text : text, 'error');
  }

  /**
   * 按钮忙碌态，防止用户连点导致 PS 命令排队。
   * 兼容性说明：部分 UXP 版本对 `element.dataset` / 属性选择器支持不完整，
   * 因此这里用 getAttribute / setAttribute 记录状态，并用计数器判断“是否有任务在跑”。
   */
  let busyCount = 0;

  function setBusy(button, busy) {
    if (!button) return;

    if (busy) {
      button.setAttribute('data-busy', '1');
      button.disabled = true;
      button.textContent = t('btn.working');
      button.classList.add('busy');
    } else {
      button.disabled = false;
      button.classList.remove('busy');
      button.removeAttribute('data-busy');

      // 恢复按钮原文案（在 bindEvents 里已经预先存好）
      const original = button.getAttribute('data-original');
      if (original) button.textContent = original;
    }
  }

  function anyBusy() {
    return busyCount > 0;
  }

  /** 刷新面板顶部的文档状态条 */
  async function refreshStatus() {
    const dot = $('docDot');
    const nameEl = $('docName');
    const sizeEl = $('docSize');
    const dpiEl = $('docDpi');
    const selEl = $('docSelection');

    function showNoDocument() {
      if (dot) dot.className = 'dot';
      if (nameEl) nameEl.textContent = t('status.noDocument');
      if (sizeEl) sizeEl.textContent = '--';
      if (dpiEl) dpiEl.textContent = '--';
      if (selEl) {
        selEl.textContent = t('status.noSelection');
        selEl.className = 'meta-val';
      }
    }

    let doc = null;
    try {
      doc = await getDocInfo();
    } catch (e) {
      // batchPlay 读文档整体失败：给出可读提示，并顺带跑一次环境自检
      log('读取文档信息失败：' + errorText(e), 'error');
      showNoDocument();
      await diagnoseEnvironment();
      return;
    }

    if (!doc || !doc.id) {
      showNoDocument();
      return;
    }

    dot.className = 'dot on';
    nameEl.textContent = doc.name +
      (doc.numberOfLayers ? '（' + doc.numberOfLayers + ' 层）' : '');
    sizeEl.textContent = (doc.width || '?') + ' × ' + (doc.height || '?') + ' px';
    dpiEl.textContent = (doc.dpi || '?') + ' ppi';

    const sel = await getSelectionInfo();
    if (sel.hasSelection) {
      selEl.textContent = sel.width + ' × ' + sel.height + ' px';
      selEl.className = 'meta-val hl';
    } else {
      selEl.textContent = t('status.noSelection');
      selEl.className = 'meta-val warn';
    }
  }

  /** 读取 UI 上的参数写回 CONFIG */
  function readSettingsFromUI() {
    const radius = $('inpRadius');
    const threshold = $('inpThreshold');
    const strength = $('inpStrength');
    const feather = $('inpFeather');
    const filter = $('selFilter');
    const keep = $('chkKeepSettings');

    if (radius) CONFIG.radius = clamp(num(radius.value, CONFIG.radius), 1, 100);
    if (threshold) CONFIG.threshold = clamp(num(threshold.value, CONFIG.threshold), 0, 255);
    if (strength) CONFIG.strength = clamp(num(strength.value, CONFIG.strength), 1, 100);
    if (feather) CONFIG.feather = clamp(num(feather.value, CONFIG.feather), 0, 200);
    if (filter) CONFIG.filterName = filter.value || CONFIG.filterName;
    if (keep) CONFIG.keepSettings = !!keep.checked;

    return CONFIG;
  }

  /** 把 CONFIG 回填到 UI 控件 */
  function writeSettingsToUI() {
    const map = [
      ['inpRadius', CONFIG.radius, 'outRadius'],
      ['inpThreshold', CONFIG.threshold, 'outThreshold'],
      ['inpStrength', CONFIG.strength, 'outStrength'],
      ['inpFeather', CONFIG.feather, 'outFeather']
    ];
    map.forEach(function (item) {
      const input = $(item[0]);
      const output = $(item[2]);
      if (input) input.value = item[1];
      if (output) output.textContent = String(item[1]);
    });
    const filter = $('selFilter');
    if (filter) filter.value = CONFIG.filterName;
    const keep = $('chkKeepSettings');
    if (keep) keep.checked = !!CONFIG.keepSettings;
  }

  /**
   * 环境自检：当 getDocInfo() 读不到文档时，依次尝试其它读取方式，
   * 把每一种的结果写进日志。这样"读不到文档"能直接定位到具体原因，
   * 而不需要用户去翻 UXP 日志。
   */
  async function diagnoseEnvironment() {
    log('开始环境自检（全部使用 DOM API）…', 'warn');

    // ① 能否拿到活动文档
    try {
      const d = app.activeDocument;
      if (d) {
        log('① 活动文档可用：' + String(safeProp(d, 'title', '?')) +
          '（' + safeProp(d, 'width', '?') + '×' + safeProp(d, 'height', '?') +
          ' @ ' + safeProp(d, 'resolution', '?') + ' ppi）', 'ok');
      } else {
        log('① app.activeDocument 为 null —— PS 里确实没有打开文档', 'error');
      }
    } catch (e) {
      log('① 读取 app.activeDocument 失败：' + errorText(e), 'error');
    }

    // ② documents 数组
    try {
      const docs = app.documents;
      log('② app.documents 长度 = ' + (docs ? docs.length : 'null'), 'info');
    } catch (e) {
      log('② 读取 app.documents 失败：' + errorText(e), 'error');
    }

    // ③ 选区
    try {
      const doc = getActiveDoc();
      const b = doc && doc.selection ? doc.selection.bounds : null;
      if (b) {
        log('③ 选区边界 = L' + Math.round(b.left) + ' T' + Math.round(b.top) +
          ' R' + Math.round(b.right) + ' B' + Math.round(b.bottom) +
          '  → ' + Math.round(Math.abs(b.right - b.left)) + '×' + Math.round(Math.abs(b.bottom - b.top)) + ' px', 'ok');
      } else {
        log('③ selection.bounds 为 null —— 当前没有选区', 'warn');
      }
    } catch (e) {
      log('③ 读取 selection.bounds 失败：' + errorText(e), 'error');
    }

    // ④ 当前图层
    try {
      const doc = getActiveDoc();
      const L = doc ? doc.activeLayer : null;
      if (L) {
        log('④ 活动图层：' + String(safeProp(L, 'name', '?')) +
          '  id=' + safeProp(L, 'id', '?') +
          '  kind=' + safeProp(L, 'kind', '?') +
          '  locked=' + safeProp(L, 'locked', '?'), 'ok');
      } else {
        log('④ 没有活动图层', 'warn');
      }
    } catch (e) {
      log('④ 读取 activeLayer 失败：' + errorText(e), 'error');
    }

    // ⑤ 模态状态
    try {
      log('⑤ core.isModal() = ' + (typeof core.isModal === 'function' ? core.isModal() : '不支持'), 'info');
    } catch (e) {
      log('⑤ core.isModal() 失败：' + errorText(e), 'error');
    }

    log('自检结束。若 ① 报错 → 没有打开文档；③ 为 null → 没有画选区。', 'info');
  }

  /**
   * 统一的功能执行包装：
   *   校验 → 忙碌态 → 执行 → 成功/失败提示 → 刷新状态
   */
  async function runFeature(button, featureName, runner, onSuccess) {
    if (anyBusy()) {
      toast(t('msg.busyWait'), 'warn');
      return;
    }

    busyCount++;
    setBusy(button, true);
    readSettingsFromUI();

    try {
      // 轻量预检，让“没有选区”这一类问题能第一时间弹提示
      await preflight({ needPixelLayer: false });

      const result = await runner();
      await refreshStatus();

      const message = onSuccess ? onSuccess(result) : t('msg.workedOk');
      log(featureName + '：' + message, 'ok');
      toast(message, 'ok');
    } catch (err) {
      reportError(featureName, err);
    } finally {
      setBusy(button, false);
      busyCount = Math.max(0, busyCount - 1);
      // 按用户偏好记住参数（localStorage 立即写，文件异步写）
      if (CONFIG.keepSettings) {
        saveSettings().catch(function () { /* 忽略持久化失败 */ });
      }
      // 不在这里再读一次状态：功能内部已经读过了，
      // 多余的一次 batchPlay 只会增加 PS 主线程负担。
    }
  }

  /** 绑定所有事件 */
  function bindEvents() {
    // 提前记下各按钮的原文案，供忙碌态结束后恢复（不依赖 dataset，兼容性更好）
    ['btnRemove', 'btnHeal', 'btnSmooth', 'btnRefresh'].forEach(function (id) {
      const el = $(id);
      if (el) el.setAttribute('data-original', el.textContent);
    });

    // 功能 1：清除杂物 / 路人
    const btnRemove = $('btnRemove');
    if (btnRemove) {
      btnRemove.addEventListener('click', function () {
        runFeature(btnRemove, t('remove.title'), removeDistraction, function (res) {
          return t('msg.removeOk') + '（' + t('msg.resOk') + res.doc.width + '×' + res.doc.height + '）';
        });
      });
    }

    // 功能 1 补充：切换修复画笔
    const btnHeal = $('btnHeal');
    if (btnHeal) {
      btnHeal.addEventListener('click', function () {
        runFeature(btnHeal, t('remove.btn2'), prepareHealingBrush, function () {
          return t('msg.healOk');
        });
      });
    }

    // 功能 2：衣物褶皱抚平
    const btnSmooth = $('btnSmooth');
    if (btnSmooth) {
      btnSmooth.addEventListener('click', function () {
        runFeature(btnSmooth, t('smooth.title'), function () {
          return smoothWrinkles(readSettingsFromUI());
        }, function (res) {
          return t('msg.smoothOk') + '（' + t('msg.resOk') + res.doc.width + '×' + res.doc.height + '）';
        });
      });
    }

    // 刷新状态（同时把结果写进日志，方便对照排查）
    const btnRefresh = $('btnRefresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async function () {
        try {
          const doc = await getDocInfo();
          if (doc && doc.id) {
            log('已检测到文档：' + doc.name + '（' + doc.width + '×' + doc.height + ' @ ' + doc.dpi + ' ppi）', 'ok');
            const sel = await getSelectionInfo();
            if (sel.hasSelection) {
              log('选区有效：' + sel.width + ' × ' + sel.height + ' px（' + sel.count + ' 条子路径）', 'ok');
            } else {
              log('当前没有选区，请先用 PS 选区工具框选区域。', 'warn');
            }
          } else {
            log('没有检测到打开中的文档。', 'error');
            await diagnoseEnvironment();
          }
          await refreshStatus();
          toast(t('msg.refreshed'), 'ok');
        } catch (e) {
          reportError('刷新状态', e);
          await diagnoseEnvironment();
        }
      });
    }

    // 清空日志
    const btnClear = $('btnClearLog');
    if (btnClear) {
      btnClear.addEventListener('click', clearLog);
    }

    // 滑块实时回显
    //
    // 【重要教训】这里原来还加了一个 setInterval(120ms) 轮询来兜底同步数值，
    // 结果它和下面的文档轮询一起，把 Photoshop 拖到 AppHang（无响应）。
    // 面板里**绝对不要**放任何周期性定时器**，只在用户操作时被动响应。
    // 现在只靠事件监听：input（拖动中）+ change（松手）+ mousemove（兼容）。
    const sliderMap = [
      ['inpRadius', 'outRadius'],
      ['inpThreshold', 'outThreshold'],
      ['inpStrength', 'outStrength'],
      ['inpFeather', 'outFeather']
    ];

    const sliderSync = function (input, output) {
      return function () {
        const v = String(input.value);
        if (output.textContent !== v) output.textContent = v;
      };
    };

    sliderMap.forEach(function (item) {
      const input = $(item[0]);
      const output = $(item[1]);
      if (!input || !output) return;

      const sync = sliderSync(input, output);
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      input.addEventListener('mousemove', sync);
      // 键盘方向键调整时也同步
      input.addEventListener('keyup', sync);
      sync();
    });

    // 语言切换
    const langSelect = $('selLang');
    if (langSelect) {
      langSelect.addEventListener('change', function () {
        i18n.setLang(langSelect.value);
        log(t('log.langSwitched') + ' / language: ' + langSelect.value, 'info');
      });
    }

    // 参数变化时按需保存
    const keep = $('chkKeepSettings');
    if (keep) {
      keep.addEventListener('change', function () {
        CONFIG.keepSettings = !!keep.checked;
        saveSettings().catch(function () { /* 忽略 */ });
      });
    }

    // 面板重新获得焦点时自动刷新状态，方便用户画完选区直接看结果
    window.addEventListener('focus', function () {
      refreshStatus();
    });

    // 点击面板任意位置也刷新一次（画完选区回到面板点一下就更新）
    document.addEventListener('click', function (e) {
      const el = e && e.target;
      const id = el && el.id ? el.id : '';
      // 点按钮时各自有处理逻辑，这里跳过，避免重复刷新
      if (id === 'btnRemove' || id === 'btnHeal' || id === 'btnSmooth' || id === 'btnRefresh') return;
      refreshStatus();
    });
  }

  /**
   * 注册 PS 文档事件监听（被动通知，不做任何轮询）。
   *
   * 【重要教训】这里原来还有一个 setInterval(1500ms) 轮询，每 1.5 秒调用一次
   * batchPlay 读文档信息。它在 PS 启动阶段会持续抢占主线程，
   * 直接把 Photoshop 拖成 AppHang（无响应）——这是"PS 用不了"的真正原因。
   *
   * 现在改为：只注册事件，完全被动响应；事件不被支持时靠面板上的
   * 【刷新状态】按钮和点击面板来手动更新，绝不再起定时器。
   */
  async function watchDocumentEvents() {
    // 只监听这几个真正影响状态的轻量事件，避免 set/layersFiltered 这类
    // 在 PS 内部会高频触发的事件反复唤醒面板脚本
    const EVENTS = [
      'open',    // 新打开文档
      'select',  // 切换活动文档
      'close',   // 关闭文档
      'make'     // 新建文档
    ];

    for (let i = 0; i < EVENTS.length; i++) {
      try {
        action.addNotificationListener([{ event: EVENTS[i] }], function () {
          // 事件回调里只做一次轻量刷新；失败也不抛出，避免影响 PS 主线程
          refreshStatus().catch(function () { /* 忽略 */ });
        });
      } catch (e) {
        // 该事件不被支持时忽略，不影响其它事件
      }
    }
  }

  /* ========================================================================
   * §10 启动
   * ===================================================================== */

  /**
   * 面板初始化。
   *
   * 【性能红线】初始化过程必须"轻"，且绝不能留下任何周期性定时器：
   *   · 面板可能因为 runOnStartup 而在 PS 启动阶段就被创建，
   *     此时任何频繁的 batchPlay 调用都会拖死 Photoshop；
   *   · 所以这里只做：载入词条 → 载入参数 → 绑定事件 → 读一次状态，然后结束。
   *   · 状态更新改为被动：用户点击面板 / 切换文档 / 点【刷新状态】时才读。
   */
  async function init() {
    try {
      // 1) 加载语言词条并应用到 DOM（纯本地，不碰 PS）
      await i18n.init();
      i18n.applyDom();

      const langSelect = $('selLang');
      if (langSelect) langSelect.value = i18n.getLang();

      // 2) 加载上次的参数（只读本地文件，失败自动降级）
      await loadSettings();
      writeSettingsToUI();

      // 3) 绑定事件
      bindEvents();

      // 4) 首屏读一次状态（仅一次）
      await refreshStatus();

      // 5) 注册文档事件监听（纯被动通知，不含任何定时器）
      await watchDocumentEvents();

      log(t('log.ready'), 'ok');
      log(t('log.env'), 'info');
      log('提示：画好选区后如果状态条没更新，点一下面板任意位置或【刷新状态】即可。', 'info');
    } catch (err) {
      // 初始化失败通常是 module 加载异常，给出可操作提示
      log(t('log.moduleFail') + ' ' + errorText(err), 'error');
      toast(t('log.moduleFail'), 'error');
    }
  }

  // UXP 面板加载完成后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
