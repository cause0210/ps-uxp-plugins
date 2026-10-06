/* =========================================================================
 * i18n.js —— 极简国际化模块（中 / 英）
 *
 * 设计要点（针对"文件夹直接丢进 PS 的 Plug-ins 目录"这种加载方式做过加固）：
 *  1. 中文 / 英文词条**直接内联在本文件里**（见下方 BUILTIN），
 *     所以插件不依赖任何外部文件也能完整显示，不存在"读不到词条变空白"的问题；
 *  2. i18n/*.json 仍然保留，如果宿主允许读取就作为可选的覆盖来源；
 *  3. 本文件既可作为 <script> 引入，也可被 require() 使用（双模式兼容）；
 *  4. 全程不联网、不依赖任何远程接口。
 * ========================================================================= */

/* global module */
if (typeof module === 'undefined') {
  // 作为普通 <script> 加载时，手动补一个 CommonJS 容器，避免 module is not defined
  window.module = { exports: {} };
}

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // main.js 里 require() 得到同一个对象
  }
  root.RetouchI18n = api; // 同时挂到 window，方便调试
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DEFAULT_LANG = 'zh_CN';
  const SUPPORTED = ['zh_CN', 'en_US'];

  /* ------------------------------------------------------------------ *
   * 内置词条：直接写进 JS，保证面板在"读不到任何外部文件"时也能正常显示。
   * 说明：插件以"文件夹放进 Photoshop 的 Plug-ins 目录"方式加载时，
   *       外部 JSON 是否可读取决于宿主环境，所以把中/英词条内联在这里作为可靠来源；
   *       i18n/*.json 仍然保留，作为可选的覆盖来源（读不到也不影响使用）。
   * ------------------------------------------------------------------ */
  const BUILTIN = {
    zh_CN: {
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
    },
    en_US: {
      "app.title": "Local Retouch Kit",
      "app.subtitle": "100% on-device · no resampling",
      "status.noDocument": "No document open",
      "status.size": "Size",
      "status.resolution": "Resolution",
      "status.selection": "Selection",
      "status.noSelection": "none",
      "status.hasSelection": "active",
      "status.untitled": "Untitled",
      "btn.refresh": "Refresh status",
      "btn.working": "Working…",
      "remove.title": "Remove clutter / people",
      "remove.desc": "Reads the native Photoshop selection and runs the local Content-Aware Fill / Remove tool to sample surrounding pixels and write the repair straight back into the original layer.",
      "remove.btn": "Remove clutter / people",
      "remove.btn2": "Spot Healing touch-up (optional)",
      "remove.hint": "Include 2–5 px of the surrounding area in your selection for the best content-aware result.",
      "smooth.title": "Smooth fabric wrinkles",
      "smooth.desc": "Surface Blur flattens only low-frequency shading (wrinkles) and keeps high-frequency fabric texture; the result is then blended with the original at the chosen strength to avoid a plastic look. The selection is used as a mask, so there are no hard edges.",
      "smooth.radius": "Blur radius (px)",
      "smooth.radiusTip": "Match the wrinkle width in pixels; higher resolutions need larger values.",
      "smooth.threshold": "Edge threshold (texture)",
      "smooth.thresholdTip": "Lower keeps more texture. Use 6–10 for a stronger effect.",
      "smooth.strength": "% strength",
      "smooth.strengthTip": "100% uses the blurred result only; 60%–80% usually flattens wrinkles while keeping weave.",
      "smooth.btn": "Smooth fabric wrinkles",
      "smooth.advanced": "Advanced: blur algorithm & feather",
      "smooth.filter": "Blur algorithm",
      "smooth.filter.surface": "Surface Blur (recommended)",
      "smooth.filter.smart": "Smart Blur",
      "smooth.filter.median": "Dust & Scratches / Median",
      "smooth.filterTip": "Median protects fine fabric weave best, but is slower.",
      "smooth.feather": "Selection feather (px)",
      "smooth.featherTip": "Above 0 adds a gradient transition at the selection edge to avoid hard repair seams.",
      "log.title": "Activity log",
      "log.clear": "Clear",
      "log.ready": "Plugin ready. Waiting for input.",
      "log.env": "Runtime: Photoshop UXP · everything runs locally, no network, no uploads.",
      "log.moduleFail": "UXP module loading failed. Make sure Photoshop is 24.4 or newer and the plugin loaded correctly.",
      "log.langSwitched": "Interface language switched",
      "opt.keep": "Remember settings",
      "msg.refreshed": "Status refreshed",
      "msg.busyWait": "Still working, please wait…",
      "msg.noDocument": "No document is open. Please open an image in Photoshop first.",
      "msg.noSelection": "No selection found. Draw a selection first with a native Photoshop tool (marquee, lasso, Quick Selection).",
      "msg.needOneLayer": "This layer cannot take a pixel-level repair (smart object, text, shape, adjustment layer, or a locked group). Rasterize it, or switch to a normal pixel layer.",
      "msg.badSelection": "The selection is too small or invalid. Please select again.",
      "msg.psBusy": "Photoshop is busy (a dialog may be open). Press Esc to dismiss it and try again.",
      "msg.repairing": "Running the local repair algorithm…",
      "msg.removeOk": "Clutter/people removed and written back to the original layer.",
      "msg.healOk": "Spot Healing touch-up complete.",
      "msg.healNoSelection": "No selection — Spot Healing was skipped.",
      "msg.smoothOk": "Wrinkles smoothed with the selection as a mask; texture preserved.",
      "msg.workedOk": "Done.",
      "msg.failed": "Processing failed.",
      "msg.undoHint": "Not happy? Press Ctrl+Z to undo, or tweak the values and try again.",
      "msg.docNotOpen": "Active document not found; the operation was cancelled.",
      "msg.resOk": "Resolution unchanged:",
      "msg.selArea": "Selection bounds",
      "msg.layer": "Layer"
    }
  };

  /** 运行时词表：以内置词条为底，允许外部 JSON 覆盖 */
  const dicts = {
    zh_CN: Object.assign({}, BUILTIN.zh_CN),
    en_US: Object.assign({}, BUILTIN.en_US)
  };

  let currentLang = DEFAULT_LANG;
  let ready = false;

  /* ------------------------------------------------------------------ *
   * 可选：读取插件目录下的 JSON 词条（读不到就用内联词条，不影响使用）
   * ------------------------------------------------------------------ */
  async function readJsonFromPlugin(relPath) {
    const uxp = require('uxp');
    const fs = uxp.storage.localFileSystem;

    // 首选：直接用插件协议路径取文件
    try {
      const entry = await fs.getEntryWithUrl('plugin:/' + relPath);
      if (entry && typeof entry.read === 'function') {
        return JSON.parse(await entry.read());
      }
    } catch (e) {
      // 某些宿主不支持 plugin:/ 协议，走下面的兜底方案
    }

    // 兜底：先拿插件根目录，再逐级取文件
    const folder = await fs.getPluginFolder();
    let node = folder;
    const parts = relPath.split('/');
    for (let i = 0; i < parts.length; i++) {
      node = await node.getEntry(parts[i]);
    }
    return JSON.parse(await node.read());
  }

  /* ------------------------------------------------------------------ *
   * 初始化：尝试用外部词条覆盖 + 决定当前语言
   * ------------------------------------------------------------------ */
  async function init() {
    for (const lang of SUPPORTED) {
      try {
        // 注意：UXP 的 locale 命名用连字符（zh-CN / en-US），
        // 所以外部词条按这个格式去找；读不到就继续用内联词条，不影响显示。
        const data = await readJsonFromPlugin('i18n/' + lang.replace('_', '-') + '.json');
        if (data && typeof data === 'object') {
          Object.keys(data).forEach(function (k) {
            if (k !== '_comment' && typeof data[k] === 'string') dicts[lang][k] = data[k];
          });
        }
      } catch (e) {
        // 读不到外部词条：保留内联词条即可，绝不抛错
      }
    }

    // 首次进入时跟随宿主语言，之后记住用户选择
    let saved = null;
    try {
      saved = window.localStorage.getItem('rtk.lang');
    } catch (e) {
      saved = null;
    }
    currentLang = SUPPORTED.indexOf(saved) >= 0 ? saved : guessLang();
    ready = true;
    return currentLang;
  }

  /** 根据宿主语言猜测默认语言 */
  function guessLang() {
    try {
      const nav = String((typeof navigator !== 'undefined' && navigator.language) || '');
      if (/zh/i.test(nav)) return 'zh_CN';
    } catch (e) { /* 忽略 */ }
    return DEFAULT_LANG;
  }
  /* ------------------------------------------------------------------ *
   * 取词
   * ------------------------------------------------------------------ */
  function t(key, fallback) {
    const d = dicts[currentLang];
    if (d && typeof d[key] === 'string') return d[key];
    const zh = dicts[DEFAULT_LANG];
    if (zh && typeof zh[key] === 'string') return zh[key];
    return typeof fallback === 'string' ? fallback : key;
  }

  function getLang() { return currentLang; }
  function isReady() { return ready; }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) < 0) return currentLang;
    currentLang = lang;
    try {
      window.localStorage.setItem('rtk.lang', lang);
    } catch (e) { /* 忽略存储失败 */ }
    applyDom();
    return currentLang;
  }

  /**
   * 把 data-i18n / data-i18n-title / data-i18n-placeholder 应用到 DOM。
   * 找不到词条时保留 HTML 里已有的中文文案（fallback）。
   */
  function applyDom(scope) {
    const rootEl = scope || document;
    rootEl.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      const fb = el.getAttribute('data-i18n-fallback') || el.textContent;
      const text = t(key, fb);
      if (text) el.textContent = text;
    });
    rootEl.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    rootEl.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    const app = document.getElementById('app');
    if (app) app.setAttribute('data-lang', currentLang);
  }

  return {
    init: init,
    t: t,
    getLang: getLang,
    setLang: setLang,
    isReady: isReady,
    applyDom: applyDom,
    supported: SUPPORTED.slice()
  };
});
