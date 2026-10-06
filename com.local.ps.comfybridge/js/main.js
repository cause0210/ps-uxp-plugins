/* =============================================================================
 * main.js —— ComfyUI 桥接插件（正式版）
 *
 * 功能：在 Photoshop 里一键调用本机 ComfyUI 做 AI 修图，结果置入为新图层。
 *      当前实现：AI 去背景（BiRefNet）
 *
 * 架构（全部在真机上实测验证过，不是理论方案）：
 *   ① 复制文档 → 用 fs.createSessionToken() 存成临时 PNG
 *      ※ 关键：batchPlay 的 save/placeEvent **不认文件路径**，必须传会话令牌
 *   ② 手工拼 multipart 上传给 ComfyUI（UXP 没有 TextEncoder，用自写 ASCII 编码器）
 *   ③ POST /prompt 提交工作流，轮询 /history 等结果
 *   ④ GET /view 下载结果 PNG 到本地文件
 *   ⑤ 用会话令牌 placeEvent 置入为新图层（PNG 带 alpha，抠图能保留透明）
 *
 * 踩过的坑（都在真机上验证过，勿重复犯错）：
 *   · UXP 没有 TextEncoder / createImageBitmap
 *   · imaging.decodeImageData / createImageDataFromBase64String 不存在
 *   · imaging.encodeImageData 永远输出 JPEG，不支持 alpha
 *   · canvas 有 getContext 但 ctx.getImageData 不存在
 *   · batchPlay 文件操作要用会话令牌，不能传路径
 *   · network 权限里 127.0.0.1 不被识别，必须用 localhost
 *   · manifest 不能有 BOM、不能有未知字段、label 不能用下划线 locale
 *   · 面板里绝对不能放 setInterval（会导致 PS 卡死）
 * ========================================================================== */
(function () {
  'use strict';

  const photoshop = require('photoshop');
  const app = photoshop.app;
  const core = photoshop.core;
  const action = photoshop.action;
  const batchPlay = action.batchPlay;

  const storage = require('uxp').storage;
  const fs = storage.localFileSystem;

  /* ==================================================================== *
   * 配置
   * ==================================================================== */
  const CFG = {
    server: 'http://localhost:8188',
    bgModel: 'birefnet.safetensors',
    prefix: 'PS_Bridge/cutout',
    inpaintPrefix: 'PS_Inpaint/pipe',
    inpaintModel: 'sd-v1-5-inpainting.ckpt',
    // 临时文件中转目录。**留空 = 自动**（用系统临时目录），
    // 这样插件在任何机器上都能直接用，不需要知道 ComfyUI 装在哪。
    // 只有当自动选择出问题时，才需要手动填一个可写目录。
    workDir: '',
    timeoutSec: 1800,   // 等待 ComfyUI 完成的秒数（超分大图可能很久）
    // ---- 局部重绘参数（均为实测得出的合理值）----
    inpaintTargetSide: 640,   // 降采样后长边；SD1.5 舒适区 512~768
    inpaintPad: 64,           // 裁切时在选区外多留的边距，给模型上下文
    inpaintSteps: 22,
    inpaintCfg: 7.5,
    inpaintGrow: 8,           // 遮罩外扩，使边缘过渡自然
    inpaintDenoise: 1.0,      // 有专用 inpaint 模型时用 1.0（标准做法）
    defaultPrompt: 'photorealistic, consistent lighting, sharp focus, high detail',
    defaultNegPrompt: 'blurry, low quality, watermark, text, seam, artifacts, distorted',

    /* ---- 去背景的边缘处理方式 ----
     * none（默认）：遮罩直接当 alpha —— 边缘锐利、主体不被侵蚀
     * soft         ：收缩 + 羽化 —— 边缘更柔和，但主体会略微变瘦、细节偏软
     */
    bgEdgeMode: 'none',

    /* ---- 局部重绘的结果方式 ----
     * region（默认）：**只输出你框选的那块区域**，不含周围
     * composite     ：贴回原图原位，选区外像素零改动
     */
    inpaintResultMode: 'region',

    /* ---- 局部重绘的两档模型 ----
     * 实测（Radeon 880M 核显，约 1 MP 处理区域）：
     *   快速  SD1.5  640px   21 秒
     *   高质量 SDXL  1024px 108 秒（慢 5 倍，但提示词遵循更好、细节更锐利）
     *
     * ⚠ SDXL 要求 ComfyUI **不能**用 --enable-dynamic-vram 启动，
     *   否则会输出纯彩色噪点（实测噪点指标 55.7 vs 正常 5.75）。
     */
    inpaintModes: {
      fast: {
        key: 'fast',
        label: '快速（SD1.5）',
        kind: 'checkpoint',
        model: 'sd-v1-5-inpainting.ckpt',
        targetSide: 640,
        steps: 22,
        cfg: 7.5,
        grow: 8,
        approxSec: 21
      },
      quality: {
        key: 'quality',
        label: '高质量（SDXL，慢约5倍）',
        kind: 'sdxlUnet',
        unet: 'sdxl_inpaint_unet_fp16.safetensors',
        clipL: 'clip_l.safetensors',
        clipG: 'clip_g.safetensors',
        vae: 'sdxl_vae.safetensors',
        targetSide: 1024,
        steps: 28,
        cfg: 7.5,
        grow: 8,
        approxSec: 108
      },
      flux: {
        key: 'flux',
        label: '最高质量（Flux Fill，很慢）',
        kind: 'fluxGGUF',
        unet: 'flux1-fill-dev-Q4_0.gguf',
        clipL: 'clip_l.safetensors',
        clipT5: 't5xxl_fp8_e4m3fn.safetensors',
        vae: 'flux_ae.safetensors',
        // 核显上只能跑 512，再大就慢到没法用（0.2MP 已需 219 秒）
        targetSide: 512,
        steps: 20,
        cfg: 1.0,
        guidance: 30.0,
        grow: 8,
        approxSec: 220
      }
    },
    defaultMode: 'fast',

    /* ---- 超分（RealESRGAN_x4plus）----
     * 模型固定 4 倍，要 2/3 倍就 4 倍后缩回。
     *
     * 实测（Radeon 880M，原图 5568×3712 = 20.7 MP）：
     *   4 倍 → 22272×14848 (330.7 MP)  70 秒  PNG 79 MB   ✅ 跑通
     *   2 倍 → 11136×7424  (82.7 MP)   —      PNG 18 MB   ✅ 跑通
     *
     * ComfyUI 的 ImageUpscaleWithModel 内部用 512×512 分块（overlap 32），
     * 所以计算本身安全。真正的瓶颈是**输出张量**与 PNG 编码：
     *   330 MP 张量约 3.7 GB，PNG 编码时还要再占一份内存。
     * 所以上限设在 400 MP，并在 120 MP 以上给出警告。
     */
    upscaleModel: 'RealESRGAN_x4plus.pth',
    upscaleMaxMP: 400,
    upscaleWarnMP: 120,
    upscaleDefault: 2,
    // 默认模式：只输出放大的选区（最符合"我框哪就给我哪"的直觉）
    upscaleMode: 'region'
  };

  /* ==================================================================== *
   * 小工具
   * ==================================================================== */
  function $(id) { return document.getElementById(id); }

  function errText(e) {
    if (!e) return 'unknown';
    if (typeof e === 'string') return e;
    return e.message || e.number || e.name || String(e);
  }

  /**
   * 替代 TextEncoder（UXP 没有）。
   * multipart 的头部/边界全是 ASCII，逐字符取低字节即可。
   */
  function asciiBytes(str) {
    const s = String(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }

  /** 把 UTF-8 字符串安全写到文本文件（避免 BOM 问题） */
  async function writeTextFile(pathStr, text) {
    const dir = pathStr.substring(0, pathStr.lastIndexOf('\\'));
    const nm = pathStr.substring(pathStr.lastIndexOf('\\') + 1);
    const folder = await fs.getEntryWithUrl('file:///' + dir.replace(/\\/g, '/'));
    const file = await folder.createFile(nm, { overwrite: true });
    await file.write(text);
    return file;
  }

  /* ==================================================================== *
   * §1 读取 Photoshop 状态（全部走 batchPlay —— DOM 的 activeLayer 不可用）
   * ==================================================================== */
  function getActiveDoc() {
    try { return app.activeDocument || null; } catch (e) { return null; }
  }

  /** 读活动文档基本信息（batchPlay 拿图层，DOM 拿文档尺寸） */
  async function getDocInfo() {
    const doc = getActiveDoc();
    if (!doc) return { open: false };

    let title = '', w = 0, h = 0;
    try { title = doc.name || '(未命名)'; } catch (e) { /* ignore */ }
    try { w = Math.round(doc.width); h = Math.round(doc.height); } catch (e) { /* ignore */ }

    // 图层信息用 batchPlay（DOM 的 activeLayer/activeLayers 都不可靠）
    let layer = null;
    try {
      const r = await batchPlay([{
        _obj: 'get',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
      }], { synchronousExecution: true });
      layer = r && r[0] ? r[0] : null;
    } catch (e) { layer = null; }

    // 图层数
    let layerCount = 0;
    try { layerCount = doc.layers ? doc.layers.length : 0; } catch (e) { /* ignore */ }

    return {
      open: true,
      title: title,
      width: w,
      height: h,
      layerCount: layerCount,
      layerName: layer ? layer.name : '未知',
      layerId: layer ? layer.layerID : null,
      layerKind: layer && layer.layerKind ? (layer.layerKind._value || layer.layerKind) : null
    };
  }

  /* ==================================================================== *
   * §2 ComfyUI 通信
   * ==================================================================== */
  async function comfyGet(path, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000) : null;
    try {
      const r = await fetch(CFG.server + path, ctrl ? { signal: ctrl.signal } : {});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function testConnection() {
    const j = await comfyGet('/system_stats', 10000);
    const dev = j.devices && j.devices[0] ? j.devices[0] : null;
    return {
      version: j.system ? j.system.comfyui_version : '?',
      device: dev ? dev.name : '?',
      vramFree: dev ? dev.vram_free : 0,
      vramTotal: dev ? dev.vram_total : 0
    };
  }

  /** 查询可用的去背景模型（顺便验证权限与网络都正常） */
  async function listBgModels() {
    const j = await comfyGet('/object_info/LoadBackgroundRemovalModel', 20000);
    const opts = j.LoadBackgroundRemovalModel.input.required.bg_removal_name[1].options;
    return opts || [];
  }

  /**
   * 查询可用的 checkpoint。
   * 注意：ComfyUI 的 COMBO 字段有两种返回格式，实测都遇到过：
   *   ["COMBO", { options: [...] }]        → 值在 [1].options（background_removal）
   *   [{ value: [...] }, { tooltip: ... }] → 值在 [0].value（checkpoints）
   * 这里两种都兼容，避免再次踩坑。
   */
  async function listCheckpoints() {
    const j = await comfyGet('/object_info/CheckpointLoaderSimple', 30000);
    const field = j.CheckpointLoaderSimple.input.required.ckpt_name;
    if (!field) return [];
    if (Array.isArray(field) && field[0] && Array.isArray(field[0].value)) return field[0].value;
    if (Array.isArray(field) && field[1] && Array.isArray(field[1].options)) return field[1].options;
    if (Array.isArray(field) && Array.isArray(field[0])) return field[0];
    return [];
  }

  /* ==================================================================== *
   * §3 文件准备与传输
   * ==================================================================== */

  /**
   * 确保临时工作目录存在。
   *
   * 【为什么要改】早期版本把目录硬编码成 `D:\ComfyUI\bridge-tmp`，
   * 导致插件**只能在某一台机器上用** —— 别人 ComfyUI 装在别处就直接失效。
   *
   * 现在按优先级自动选，**不需要知道 ComfyUI 装在哪**（插件只通过 HTTP 与它通信）：
   *   ① 用户手动指定的目录（设置里可填，留空则自动）
   *   ② UXP 的临时目录（每个系统都有、必定可写）    ← 默认走这条
   *   ③ 插件专属数据目录（兜底）
   *
   * 注意：这里只需要一个"插件能写、PS 能通过会话令牌访问"的目录，
   *       与 ComfyUI 的安装位置毫无关系（文件是上传过去的，不是放进去的）。
   */
  let cachedWorkDir = null;

  async function ensureWorkDir() {
    if (cachedWorkDir) return cachedWorkDir;

    // ① 用户指定
    const custom = (CFG.workDir || '').trim();
    if (custom) {
      try {
        const url = 'file:///' + custom.replace(/\\/g, '/').replace(/\/+$/, '');
        cachedWorkDir = await fs.getEntryWithUrl(url);
        return cachedWorkDir;
      } catch (e) {
        log('自定义工作目录不可用，改用系统临时目录: ' + errText(e), 'warn');
      }
    }

    // ② 系统临时目录（跨平台通用）
    try {
      const tmp = await fs.getTemporaryFolder();
      try {
        cachedWorkDir = await tmp.createFolder('ps-comfy-bridge');
      } catch (e) {
        // 已存在时 createFolder 会抛错，改成取出来
        cachedWorkDir = await tmp.getEntry('ps-comfy-bridge');
      }
      log('工作目录: 系统临时目录 ps-comfy-bridge', 'info');
      return cachedWorkDir;
    } catch (e) {
      log('系统临时目录不可用: ' + errText(e), 'warn');
    }

    // ③ 插件数据目录兜底
    try {
      cachedWorkDir = await fs.getDataFolder();
      log('工作目录: 插件数据目录', 'info');
      return cachedWorkDir;
    } catch (e) {
      throw new Error('找不到可写的工作目录。请在设置里手动指定一个（例如 D:\\ComfyUI\\bridge-tmp）');
    }
  }

  /**
   * 把当前文档复制一份并存成临时 PNG 文件。
   * 为什么要复制：save 会带上整个文档，直接存会干扰用户；复制一份更安全。
   * 为什么要会话令牌：batchPlay 的文件参数不认路径，只认 token。
   */
  async function exportDocToPng(fileName) {
    const workDir = await ensureWorkDir();
    const file = await workDir.createFile(fileName, { overwrite: true });
    const token = fs.createSessionToken(file);

    let dupId = null;
    try {
      // 复制文档（合并所有可见图层，确保拿到的是所见画面）
      const r = await core.executeAsModal(async function () {
        return await batchPlay([{
          _obj: 'duplicate',
          _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
          duplicate: { _obj: 'document', name: '__COMFY_TMP__' },
          merged: true
        }], { synchronousExecution: true });
      }, { commandName: '导出到 ComfyUI' });
      dupId = r && r[0] ? r[0].documentID : null;

      // 保存副本到会话令牌
      await core.executeAsModal(async function () {
        await batchPlay([
          { _obj: 'select', _target: [{ _ref: 'document', _id: dupId }],
            _options: { dialogOptions: 'dontDisplay' } },
          {
            _obj: 'save',
            as: { _obj: 'PNGFormat', method: { _enum: 'PNGMethod', _value: 'quick' } },
            in: { _path: token, _kind: 'local' },
            copy: true,
            _options: { dialogOptions: 'dontDisplay' }
          }
        ], { synchronousExecution: true });
      }, { commandName: '导出到 ComfyUI' });

      // 读回校验
      const buf = await file.read({ format: storage.formats.binary });
      const bytes = new Uint8Array(buf);
      const isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
      if (!isPng) throw new Error('导出的文件不是有效 PNG');

      return { file: file, bytes: bytes };
    } finally {
      // 无论成败都要关掉临时副本
      if (dupId !== null) {
        try {
          await core.executeAsModal(async function () {
            await batchPlay([{
              _obj: 'close',
              _target: [{ _ref: 'document', _id: dupId }],
              saving: { _enum: 'saveOptions', _value: 'dontSave' }
            }], { synchronousExecution: true });
          }, { commandName: '关闭临时副本' });
        } catch (e) { /* 关不掉就留着，不阻断主流程 */ }
      }
    }
  }

  /** 手工拼 multipart 上传（不用 FormData，UXP 支持不确定） */
  async function uploadToComfy(bytes, fileName) {
    const boundary = '----ComfyBridge' + Date.now();
    const head = '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="image"; filename="' + fileName + '"\r\n' +
      'Content-Type: image/png\r\n\r\n';
    const tail = '\r\n--' + boundary + '--\r\n';

    const hb = asciiBytes(head);
    const tb = asciiBytes(tail);
    const body = new Uint8Array(hb.length + bytes.length + tb.length);
    body.set(hb, 0);
    body.set(bytes, hb.length);
    body.set(tb, hb.length + bytes.length);

    const r = await fetch(CFG.server + '/upload/image', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: body
    });
    const txt = await r.text();
    if (!r.ok) throw new Error('上传失败 HTTP ' + r.status + ': ' + txt.slice(0, 200));
    const j = JSON.parse(txt);
    if (!j.name) throw new Error('上传响应异常: ' + txt.slice(0, 200));
    return j.name;
  }

  /** 从 ComfyUI 下载结果并写入本地文件 */
  async function downloadResult(info, fileName) {
    let url = '/view?filename=' + encodeURIComponent(info.filename) +
              '&type=' + (info.type || 'output');
    if (info.subfolder) url += '&subfolder=' + encodeURIComponent(info.subfolder);

    const r = await fetch(CFG.server + url);
    if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
    const ab = await r.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (!(bytes[0] === 137 && bytes[1] === 80)) throw new Error('下载的内容不是 PNG');

    const workDir = await ensureWorkDir();
    const file = await workDir.createFile(fileName, { overwrite: true });
    await file.write(ab, { format: storage.formats.binary });
    return file;
  }

  /** 用会话令牌把文件置入为新图层 */
  async function placeFileAsLayer(file) {
    const token = fs.createSessionToken(file);
    await core.executeAsModal(async function () {
      await batchPlay([{
        _obj: 'placeEvent',
        null: { _path: token, _kind: 'local' },
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
        _options: { dialogOptions: 'dontDisplay' }
      }], { synchronousExecution: true });
    }, { commandName: '置入 ComfyUI 结果' });
  }

  /**
   * 去背景工作流。有两种边缘处理方式，由 CFG.bgEdgeMode 决定：
   *
   *   'none'（默认）：遮罩直接当 alpha —— 原版做法，边缘锐利、主体不被侵蚀
   *   'soft'        ：收缩 + 羽化 —— 边缘更柔和，但主体会略微变瘦、细节会软一点
   *
   * 说明：'soft' 的实测数据是过渡区从 0.88% 提到 2.11%，理论上更自然；
   * 但实际观感因人而异（有人觉得变模糊了），所以做成可切换，默认用 'none'。
   */
  function buildRemoveBgWorkflow(imageName, W, H) {
    const soft = (CFG.bgEdgeMode === 'soft');
    const minSide = Math.min(W || 1000, H || 1000);
    const step = Math.max(1, Math.round(minSide / 1024));
    const choke = Math.min(12, Math.max(1, step * 2));
    const feather = Math.min(20, Math.max(2, step * 3));

    const wf = {
      '1': { class_type: 'LoadImage', inputs: { image: imageName } },
      '2': { class_type: 'LoadBackgroundRemovalModel',
             inputs: { bg_removal_name: CFG.bgModel } },
      '3': { class_type: 'RemoveBackground',
             inputs: { bg_removal_model: ['2', 0], image: ['1', 0] } },
      // BiRefNet 输出的遮罩方向与 JoinImageWithAlpha 相反，必须先反转，
      // 否则会得到「白色剪影 + 保留背景」
      '4': { class_type: 'InvertMask', inputs: { mask: ['3', 0] } }
    };

    if (soft) {
      // 收缩（expand 为负 = 向内侵蚀）→ 羽化
      wf['5'] = { class_type: 'GrowMask',
                  inputs: { mask: ['4', 0], expand: -choke, tapered_corners: true } };
      wf['6'] = { class_type: 'MaskToImage', inputs: { mask: ['5', 0] } };
      wf['7'] = { class_type: 'ImageBlur',
                  inputs: { image: ['6', 0], blur_radius: feather, sigma: 1.0 } };
      wf['8'] = { class_type: 'ImageToMask', inputs: { image: ['7', 0], channel: 'red' } };
      wf['9'] = { class_type: 'JoinImageWithAlpha',
                  inputs: { image: ['1', 0], alpha: ['8', 0] } };
    } else {
      wf['9'] = { class_type: 'JoinImageWithAlpha',
                  inputs: { image: ['1', 0], alpha: ['4', 0] } };
    }

    wf['10'] = { class_type: 'SaveImage',
                 inputs: { images: ['9', 0], filename_prefix: CFG.prefix } };
    wf._meta = { soft: soft, choke: soft ? choke : 0, feather: soft ? feather : 0 };
    return wf;
  }

  /** 提交工作流并轮询等待结果 */
  async function runWorkflow(workflow, onProgress) {
    const r = await fetch(CFG.server + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'ps_comfy_bridge' })
    });
    const j = await r.json();
    if (!j.prompt_id) throw new Error('提交被拒: ' + JSON.stringify(j).slice(0, 300));

    const pid = j.prompt_id;
    const t0 = Date.now();
    let lastTick = 0;

    // 多图超分这类任务耗时可能很久，给一个更宽松的上限
    const limit = CFG.timeoutSec;

    while (true) {
      const elapsed = (Date.now() - t0) / 1000;
      if (elapsed > limit) throw new Error('等待超时（' + limit + ' 秒）');

      const hist = await comfyGet('/history/' + pid, 20000);
      const rec = hist[pid];
      if (rec) {
        const st = rec.status || {};
        if (st.completed) {
          for (const nid in rec.outputs) {
            const imgs = rec.outputs[nid].images;
            if (imgs && imgs.length) {
              return { image: imgs[0], seconds: (Date.now() - t0) / 1000 };
            }
          }
          throw new Error('推理完成但没有输出图片');
        }
        if (st.status_str === 'error') {
          throw new Error('推理出错: ' + JSON.stringify(st.messages || st).slice(0, 400));
        }
      }

      const sec = Math.floor(elapsed);
      if (onProgress && sec - lastTick >= 3) {
        lastTick = sec;
        onProgress(sec, 'AI 推理中…');
      }
      await new Promise(function (res) { setTimeout(res, 1000); });
    }
  }

  /* ==================================================================== *
   * §4b 局部重绘（inpaint）
   *
   * 架构要点（为什么这样分工）：
   *   这台 PS 上**所有创建/修改选区的 API 都不可用**（已实测）：
   *     batchPlay selectAll / set selection → 命令当前不可用
   *     DOM selection.select()              → 不是函数
   *   但读选区边界、建删图层、填充、导出文档都正常。
   *
   *   所以把复杂度全部放到 ComfyUI 侧：
   *     PS 只做两件事：① 导出全尺寸原图（已有逻辑）
   *                    ② 用纯 JS 算出全尺寸遮罩 PNG（不碰任何选区 API）
   *     ComfyUI 负责：裁切 → 降采样 → inpaint → 放大 → 贴回原图
   *   这样 PS 侧完全不需要裁切/缩放/坐标换算/图层合成。
   *
   * 输入给 ComfyUI 的参数：原图文件名、遮罩文件名、裁切框、目标尺寸、提示词
   * 输出：一张**与原图同尺寸**的 PNG，插件直接置入即可精确对齐。
   * ==================================================================== */

  /** 读当前文档的选区包围盒。返回 null 表示没有选区或选区等于整幅 */
  async function readSelectionBox(docW, docH) {
    const r = await batchPlay([{
      _obj: 'get',
      _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
    }], { synchronousExecution: true });
    const sel = r[0] && r[0].selection;
    if (!sel || sel.left === undefined) return null;

    const g = function (v) { return (v && v._value !== undefined) ? v._value : v; };
    const box = {
      left: Math.round(g(sel.left)), top: Math.round(g(sel.top)),
      right: Math.round(g(sel.right)), bottom: Math.round(g(sel.bottom))
    };
    box.w = box.right - box.left;
    box.h = box.bottom - box.top;
    if (box.w <= 0 || box.h <= 0) return null;

    // 选区覆盖整个画布 → 视为「没框选」，因为那样重绘整图没有意义且极危险
    box.fullCanvas = (Math.abs(box.w - docW) < 2 && Math.abs(box.h - docH) < 2 &&
                      Math.abs(box.left) < 2 && Math.abs(box.top) < 2);
    return box;
  }

  /** 把二进制写成本地文件 */
  async function writeBinaryFile(fileName, bytes) {
    const dir = await ensureWorkDir();
    const file = await dir.createFile(fileName, { overwrite: true });
    await file.write(bytes.buffer ? bytes.buffer : bytes, { format: storage.formats.binary });
    return file;
  }

  /**
   * 由选区包围盒算裁切框与降采样尺寸。
   * 这是整个方案里唯一的"数学"，也是防止死机的关键：
   * 之前拿 5568×3712 整图跑 SD1.5 直接导致系统死机，
   * 因为 attention 计算量随像素数平方增长，20.7 MP 是舒适区的 50 倍以上。
   */
  function computeInpaintGeometry(W, H, box, targetSide) {
    const pad = CFG.inpaintPad;
    const left = Math.max(0, box.left - pad);
    const top = Math.max(0, box.top - pad);
    const right = Math.min(W, box.right + pad);
    const bottom = Math.min(H, box.bottom + pad);
    const cw = right - left, ch = bottom - top;

    // targetSide 传 0 表示"不缩放，就用裁切原尺寸"（超分走这条路）
    // 注意不能用 `targetSide || 默认值` —— 0 会被当成假值，反而套用了默认缩放
    const side = (targetSide === undefined || targetSide === null)
      ? CFG.inpaintTargetSide : targetSide;

    let tw, th;
    if (side > 0) {
      const scale = Math.min(1.0, side / Math.max(cw, ch));
      tw = Math.max(8, (Math.round(cw * scale) >> 3) << 3);
      th = Math.max(8, (Math.round(ch * scale) >> 3) << 3);
    } else {
      tw = cw; th = ch;
    }

    return {
      crop: { x: left, y: top, w: cw, h: ch },
      target: { w: tw, h: th },
      scale: side > 0 ? Math.min(1.0, side / Math.max(cw, ch)) : 1,
      srcPixels: W * H,
      workPixels: tw * th
    };
  }

  /* ==================================================================== *
   * §4e 超分工作流
   *
   * 【RealESRGAN 的关键限制】模型**固定 4 倍**，没有 2 倍版本。
   * 所以即使你只要 2 倍，ComfyUI 也**必须先把 4 倍的张量算出来**再缩回去。
   *
   * 这意味着整图超分的内存消耗是致命的：
   *   5568×3712 (20.7 MP) 的图 → 4 倍中间张量 = 22272×14848 (330.7 MP)
   *   ≈ 3.7 GB（float32，还没算开销）
   * 实测：因为之前加载的模型还占着内存，这个任务把系统可用内存压到只剩 4.3 GB，
   *       然后开始换页，跑了几十分钟都没完。
   *
   * 【解决办法：只处理选区】
   *   裁切选区 → 超分 → 缩回裁切尺寸 → 贴回原图
   *   处理量从 330 MP 降到约 10 MP（小三十分之一），几秒就完。
   *   结果：文档尺寸不变，但**选区内的细节被 AI 重建**，明显更锐利。
   * ==================================================================== */

  /**
   * 选区超分工作流：只增强选区，贴回原图（文档尺寸不变）
   *
   * 流程：裁切 → 4倍超分 → 缩回裁切尺寸 → 用裁切遮罩贴回原图
   * 只替换遮罩为白的位置，所以**选区外像素零改动**。
   */
  function buildUpscaleSelectionWorkflow(g, imgName, maskName) {
    const cx = g.crop.x, cy = g.crop.y, cw = g.crop.w, ch = g.crop.h;
    return {
      '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: CFG.upscaleModel } },
      '2': { class_type: 'LoadImage', inputs: { image: imgName } },
      '3': { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } },

      // 裁出选区（+边距）
      '4': { class_type: 'ImageCrop',
             inputs: { image: ['2', 0], width: cw, height: ch, x: cx, y: cy } },

      // 4 倍超分（只作用在小裁切块上，内存可控）
      '5': { class_type: 'ImageUpscaleWithModel',
             inputs: { upscale_model: ['1', 0], image: ['4', 0] } },

      // 缩回原裁切尺寸 —— 这一步才是"AI 重建细节"的关键：
      // 模型在 4 倍空间里补出了真实纹理，缩回来后比原图更锐利干净
      '6': { class_type: 'ImageScale',
             inputs: { image: ['5', 0], upscale_method: 'lanczos',
                       width: cw, height: ch, crop: 'disabled' } },

      // 贴回原图（只替换遮罩为白处）
      '7': { class_type: 'ImageCompositeMasked',
             inputs: { destination: ['2', 0], source: ['6', 0],
                       x: cx, y: cy, resize_source: false, mask: ['3', 0] } },

      '8': { class_type: 'SaveImage',
             inputs: { images: ['7', 0], filename_prefix: 'PS_Upscale/region' } }
    };
  }

  /**
   * 整图超分工作流：放大整张图（文档尺寸变大）
   *
   * ⚠ 内存风险：4 倍中间张量 = 原图 16 倍像素。
   *   20.7 MP 的图 → 330 MP 中间张量 → 约 3.7 GB，实测会把内存压到换页。
   *   所以调用前必须用中间张量的大小做护栏。
   */
  function buildUpscaleFullWorkflow(imgName, factor) {
    const wf = {
      '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: CFG.upscaleModel } },
      '2': { class_type: 'LoadImage', inputs: { image: imgName } },
      // 模型固定 4 倍
      '3': { class_type: 'ImageUpscaleWithModel',
             inputs: { upscale_model: ['1', 0], image: ['2', 0] } }
    };
    if (factor !== 4) {
      wf['4'] = { class_type: 'ImageScaleBy',
                  inputs: { image: ['3', 0], upscale_method: 'lanczos',
                            scale_by: factor / 4 } };
      wf['5'] = { class_type: 'SaveImage',
                  inputs: { images: ['4', 0], filename_prefix: 'PS_Upscale/full' } };
    } else {
      wf['5'] = { class_type: 'SaveImage',
                  inputs: { images: ['3', 0], filename_prefix: 'PS_Upscale/full' } };
    }
    return wf;
  }

  /**
   * 选区独立放大工作流：**只输出放大的选区**（用户最想要的那种）
   *
   * 裁切精确到选区边界（不加边距），4 倍超分后缩到目标倍数，直接输出。
   * 结果就是"我所框选的那块区域"，放大了 N 倍，作为新图层置入。
   */
  function buildUpscaleRegionWorkflow(box, imgName, factor) {
    const bw = box.right - box.left, bh = box.bottom - box.top;
    const wf = {
      '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: CFG.upscaleModel } },
      '2': { class_type: 'LoadImage', inputs: { image: imgName } },
      // 精确裁到选区边界（不留边距，因为输出的就是这块）
      '3': { class_type: 'ImageCrop',
             inputs: { image: ['2', 0], width: bw, height: bh,
                       x: box.left, y: box.top } },
      // 模型固定 4 倍
      '4': { class_type: 'ImageUpscaleWithModel',
             inputs: { upscale_model: ['1', 0], image: ['3', 0] } }
    };
    if (factor !== 4) {
      wf['5'] = { class_type: 'ImageScaleBy',
                  inputs: { image: ['4', 0], upscale_method: 'lanczos',
                            scale_by: factor / 4 } };
      wf['6'] = { class_type: 'SaveImage',
                  inputs: { images: ['5', 0], filename_prefix: 'PS_Upscale/region_only' } };
    } else {
      wf['6'] = { class_type: 'SaveImage',
                  inputs: { images: ['4', 0], filename_prefix: 'PS_Upscale/region_only' } };
    }
    return wf;
  }

  /** 读某个节点某个 COMBO 字段的可选值（两种返回格式都兼容） */
  async function listField(node, field) {
    const j = await comfyGet('/object_info/' + node, 30000);
    const f = (j[node] && j[node].input && j[node].input.required)
      ? j[node].input.required[field] : null;
    if (!f) return [];
    if (Array.isArray(f) && f[0] && Array.isArray(f[0].value)) return f[0].value;
    if (Array.isArray(f) && f[1] && Array.isArray(f[1].options)) return f[1].options;
    if (Array.isArray(f) && Array.isArray(f[0])) return f[0];
    return [];
  }

  /** 查可用的超分模型 */
  function listUpscalers() { return listField('UpscaleModelLoader', 'model_name'); }

  /* ==================================================================== *
   * §4c 从选区生成遮罩（纯色图层法）
   *
   * 【为什么改用这个方法】
   *   原来用「读选区包围盒 → 画矩形」，套索/快速选择画的**不规则形状会被
   *   当成它的外接矩形**，遮罩不准确。
   *
   *   新方法（读自 YAO_V1.0.4 并实测验证）：
   *     **有选区时，Photoshop 会自动把选区变成纯色图层的图层蒙版。**
   *     所以只要有选区，建两个纯色图层（黑+白）再读像素，就得到了精确的遮罩图。
   *     实测可以完整还原套索画出的任意多边形。
   *
   * 【三个必须注意的点（都是实测踩出来的）】
   *   1. `imaging.getPixels` 与 `doc.activeHistoryState` 赋值**必须在
   *      executeAsModal 作用域内**，否则报
   *      "The requested functionality is only allowed from inside a modal scope"
   *      所以「建图层 + 读像素 + 恢复历史」整体放进**同一个** modal。
   *   2. 读出的像素极性是**反的**（选区形状 = 黑，选区外 = 白）。
   *      YAO 代码里的 `invert` 参数实测**无效**（那两个是纯色内容图层，
   *      invert 命令对它们不起作用），所以极性翻转在我们自己的编码器里做。
   *   3. 用历史状态还原比"加图层再删图层"更干净 —— 连 flatten 都能撤销，
   *      而且失败时也能恢复。
   * ==================================================================== */

  /**
   * 建纯色图层的 batchPlay 序列（复刻自 YAO 的 _createFillLayersAction）。
   * 先 flatten 保证画面上只有我们的两个图层，然后黑、白两层，
   * 最后把白层移到底部，使复合结果为「选区内黑、选区外白」。
   */
  function createFillLayersAction() {
    return [
      { _obj: 'flattenImage', _options: { dialogOptions: 'dontDisplay' } },
      { _obj: 'flattenImage' },
      { _obj: 'make',
        _target: [{ _ref: 'contentLayer' }],
        using: { _obj: 'contentLayer',
                 type: { _obj: 'solidColorLayer',
                         color: { _obj: 'RGBColor', red: 0, green: 0, blue: 0 } } } },
      { _obj: 'make',
        _target: [{ _ref: 'contentLayer' }],
        using: { _obj: 'contentLayer',
                 type: { _obj: 'solidColorLayer',
                         color: { _obj: 'RGBColor', red: 255, green: 255, blue: 255 } } } },
      { _obj: 'move',
        _target: [{ _enum: 'ordinal', _ref: 'layer', _value: 'targetEnum' }],
        adjustment: false, to: { _index: 1, _ref: 'layer' }, version: 5 }
    ];
  }

  /**
   * 生成裁切区域大小的遮罩 PNG（白 = 要重绘）。
   *
   * 只读裁切区域那么大的像素（不是整张图）—— 20.7 MP 的图只读 0.4 MP，
   * 又快又省内存。所以可以用 8 位灰度，保留选区边缘的抗锯齿，重绘衔接更自然。
   *
   * @returns {{png: Uint8Array, geo: object}} 遮罩 PNG 字节 + 几何参数
   */
  async function generateSelectionMaskCrop(W, H, box, targetSide) {
    const geo = computeInpaintGeometry(W, H, box, targetSide);
    const c = geo.crop;

    const raw = await core.executeAsModal(async function () {
      const d = app.activeDocument;
      const saved = d.activeHistoryState;
      let info = null, err = null;

      try {
        // ① 建纯色图层（PS 自动把选区变成图层蒙版）
        const r = await batchPlay(createFillLayersAction(), { synchronousExecution: true });
        for (const item of (r || [])) {
          if (item && item._obj === 'error') throw new Error(item.message || '纯色图层序列失败');
        }

        // ② 读裁切区域的像素（必须在 modal 内）
        const gp = await photoshop.imaging.getPixels({
          documentID: d.id,
          sourceBounds: { left: c.x, top: c.y, right: c.x + c.w, bottom: c.y + c.h },
          targetSize: { width: c.w, height: c.h },
          componentSize: 8,
          applyAlpha: false,
          colorProfile: 'sRGB IEC61966-2.1',
          colorSpace: 'RGB'
        });
        if (!gp || !gp.imageData) throw new Error('getPixels 未返回图像数据');

        const img = gp.imageData;
        const buf = await img.getData({ chunky: true });
        info = {
          width: img.width,
          height: img.height,
          components: img.components,
          bytes: new Uint8Array(buf.buffer || buf)
        };
        if (img.dispose) { try { img.dispose(); } catch (e) { /* ignore */ } }

      } catch (e) {
        err = errText(e);
      } finally {
        // ③ 恢复历史状态（也在 modal 内）—— 连 flatten 都能干净撤销
        try { d.activeHistoryState = saved; }
        catch (e2) { if (!err) err = '恢复历史状态失败: ' + errText(e2); }
      }

      if (err) throw new Error(err);
      return info;
    }, { commandName: '生成选区遮罩' });

    const M = (typeof window !== 'undefined' && window.RetouchMaskPng) ? window.RetouchMaskPng : null;
    if (!M) throw new Error('遮罩模块未加载（js/maskpng.js 缺失或加载失败）');

    // 极性翻转在这里做（PS 读出来是反的）
    const png = M.encodeGrayFromRaw2(raw.width, raw.height, raw.bytes, raw.components, true);

    // 统计遮罩占比 —— 用于提示用户"选区太大"
    // 实测经验：占 5~30% 效果最好；超过 40% 会出现杂乱内容；
    // 60% 以上基本就是让 AI 重画主体，必然失败。
    let whiteCount = 0;
    const total = raw.width * raw.height;
    const comp = raw.components;
    for (let i = 0; i < total; i++) {
      let v;
      if (comp === 1) v = raw.bytes[i];
      else {
        const p = i * comp;
        v = (comp === 4 && raw.bytes[p + 3] === 0) ? 0 : raw.bytes[p];
      }
      if (v < 128) whiteCount++;     // PS 读出来是反的：黑=选区
    }
    const ratio = total > 0 ? (whiteCount / total) : 0;

    return { png: png, geo: geo, raw: raw, ratio: ratio };
  }

  /* ==================================================================== *
   * §5 界面
   * ==================================================================== */
  const LOG_MAX = 200;
  const LOG_HINT_DEFAULT = '日志可折叠 —— 折叠后能更快看到上面的功能按钮';

  function log(msg, level) {
    const text = String(msg);
    const lvl = level || 'info';
    try {
      if (lvl === 'error') console.error('[ComfyUI桥接]', text);
      else if (lvl === 'warn') console.warn('[ComfyUI桥接]', text);
      else console.log('[ComfyUI桥接]', text);
    } catch (e) { /* ignore */ }

    const box = $('log');
    if (!box) return;

    const line = document.createElement('div');
    line.className = 'log-line ' + lvl;

    const t = document.createElement('span');
    t.className = 'log-time';
    const d = new Date();
    t.textContent = String(d.getHours()).padStart(2, '0') + ':' +
                    String(d.getMinutes()).padStart(2, '0') + ':' +
                    String(d.getSeconds()).padStart(2, '0');

    const b = document.createElement('span');
    b.className = 'log-msg';
    b.textContent = text;

    line.appendChild(t);
    line.appendChild(b);

    // 【滚动策略】只有用户**本来就在底部**时才自动跟到底。
    // 之前是每次都强制滚到底，导致想往上翻看历史时被新日志不断拽回去。
    const atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 24;

    box.appendChild(line);
    while (box.children.length > LOG_MAX) box.removeChild(box.firstChild);

    if (atBottom) box.scrollTop = box.scrollHeight;
    else showNewLogHint();
  }

  /** 用户往上翻了、又有新日志时，提示一下（而不是硬把画面拽走） */
  function showNewLogHint() {
    const el = $('logHint');
    if (!el) return;
    el.textContent = '↓ 有新日志（点这里跳到最新）';
    el.classList.add('hint-new');
  }

  let toastTimer = null;
  function toast(msg, type) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show ' + (type || 'info');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast ' + (type || 'info'); }, 3000);
  }

  let busy = false;
  function setBusy(on, text) {
    busy = on;
    ['btnRemoveBg', 'btnInpaint', 'btnUpscale', 'btnTest', 'btnRefresh'].forEach(function (id) {
      const el = $(id);
      if (el) el.disabled = on;
    });
    const st = $('status');
    if (st && text) {
      st.textContent = text;
      st.className = 'status working';
    }
  }

  function setStatus(text, cls) {
    const st = $('status');
    if (!st) return;
    st.textContent = text;
    st.className = 'status ' + (cls || '');
  }

  /* ---- 状态刷新 ---- */
  async function refreshDocStatus() {
    try {
      const d = await getDocInfo();
      const el = $('docInfo');
      if (!el) return;
      if (!d.open) {
        el.innerHTML = '<span class="no">未打开文档</span>';
        return;
      }
      el.innerHTML =
        '<span class="yes">' + escapeHtml(d.title) + '</span>' +
        ' &nbsp;' + d.width + '×' + d.height +
        ' &nbsp;图层: ' + escapeHtml(String(d.layerName));
    } catch (e) {
      const el = $('docInfo');
      if (el) el.innerHTML = '<span class="no">读取失败</span>';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ==================================================================== *
   * §6 主流程：AI 去背景
   * ==================================================================== */
  async function removeBackground() {
    if (busy) { toast('正在处理中，请稍候', 'warn'); return; }

    const doc = getActiveDoc();
    if (!doc) { toast('请先打开一张图片', 'error'); log('没有打开文档', 'error'); return; }

    // 需要文档尺寸来推算边缘处理的收缩/羽化量
    let W = 0, H = 0;
    try { W = Math.round(doc.width); H = Math.round(doc.height); } catch (e) { /* ignore */ }

    setBusy(true, '准备中…');
    log('──────── 开始 AI 去背景 ────────', 'info');
    log('文档: ' + W + '×' + H, 'info');
    const tAll = Date.now();

    try {
      /* ① 检查 ComfyUI 连接 */
      setStatus('连接 ComfyUI…', 'working');
      log('① 连接 ComfyUI: ' + CFG.server, 'info');
      let info;
      try {
        info = await testConnection();
      } catch (e) {
        throw new Error('连不上 ComfyUI（' + errText(e) + '）。请确认 ComfyUI 已启动，' +
          '且地址正确：' + CFG.server);
      }
      log('   已连接，ComfyUI ' + info.version + ' / ' + info.device +
          '（显存空闲 ' + (info.vramFree / 1073741824).toFixed(2) + ' GB）', 'ok');

      /* ② 确认模型可用 */
      setStatus('检查模型…', 'working');
      const models = await listBgModels();
      log('② 可用去背景模型: ' + (models.length ? models.join(', ') : '（无）'), 'info');
      if (models.indexOf(CFG.bgModel) < 0) {
        throw new Error('ComfyUI 里没有模型「' + CFG.bgModel + '」。' +
          '请把它放到 ComfyUI\\models\\background_removal\\ 目录下。' +
          '当前可用: ' + (models.join(', ') || '（空）'));
      }

      /* ③ 导出当前文档为临时 PNG */
      setStatus('导出图片…', 'working');
      log('③ 导出当前文档为临时 PNG…', 'info');
      const tExport = Date.now();
      const exported = await exportDocToPng('ps_input.png');
      log('   导出完成: ' + (exported.bytes.length / 1048576).toFixed(1) + ' MB（' +
          ((Date.now() - tExport) / 1000).toFixed(1) + ' 秒）', 'ok');

      /* ④ 上传 */
      setStatus('上传到 ComfyUI…', 'working');
      log('④ 上传到 ComfyUI…', 'info');
      const remoteName = await uploadToComfy(exported.bytes, 'ps_input.png');
      log('   上传成功，ComfyUI 侧文件名: ' + remoteName, 'ok');

      /* ⑤ 提交工作流并等待 */
      setStatus('AI 推理中…', 'working');
      log('⑤ 提交去背景工作流，等待推理…', 'info');
      const wf = buildRemoveBgWorkflow(remoteName, W, H);
      if (wf._meta) {
        if (wf._meta.soft) {
          log('   边缘处理: 收缩 ' + wf._meta.choke + ' px + 羽化 ' +
              wf._meta.feather + ' px（柔和模式）', 'info');
        } else {
          log('   边缘处理: 标准（遮罩直接作为 alpha，边缘锐利）', 'info');
        }
        delete wf._meta;   // 不能把自定义字段发给 ComfyUI
      }
      const result = await runWorkflow(wf, function (sec) {
        setStatus('AI 推理中… ' + sec + ' 秒', 'working');
      });
      log('   推理完成，耗时 ' + result.seconds.toFixed(1) + ' 秒', 'ok');

      /* ⑥ 下载结果 */
      setStatus('下载结果…', 'working');
      log('⑥ 下载结果图片…', 'info');
      const outFile = await downloadResult(result.image, 'ps_result.png');
      log('   已下载并保存到临时目录', 'ok');

      /* ⑦ 置入为新图层 */
      setStatus('置入图层…', 'working');
      log('⑦ 置入为新图层…', 'info');
      const before = doc.layers ? doc.layers.length : 0;
      await placeFileAsLayer(outFile);
      let after = before;
      try { after = getActiveDoc().layers.length; } catch (e) { /* ignore */ }

      const total = ((Date.now() - tAll) / 1000).toFixed(1);
      log('   图层数: ' + before + ' → ' + after, 'ok');
      log('──────── 完成，总耗时 ' + total + ' 秒 ────────', 'ok');

      setStatus('完成（' + total + ' 秒）', 'done');
      toast('AI 去背景完成，已置入新图层', 'ok');
      await refreshDocStatus();

    } catch (e) {
      const msg = errText(e);
      log('失败: ' + msg, 'error');
      setStatus('失败', 'failed');
      toast(msg.slice(0, 120), 'error');
    } finally {
      setBusy(false);
    }
  }

  /* ==================================================================== *
   * §6c 主流程：AI 超分
   *
   * 按有没有选区分两条路：
   *   有选区 → 只处理选区，贴回原图（文档尺寸不变，选区细节被 AI 重建）
   *            处理量从数百 MP 降到约 10 MP，几秒完成
   *   无选区 → 放大整张图（文档尺寸变大），但有严格的内存护栏
   * ==================================================================== */
  async function upscaleImage() {
    if (busy) { toast('正在处理中，请稍候', 'warn'); return; }

    const doc = getActiveDoc();
    if (!doc) { toast('请先打开一张图片', 'error'); log('没有打开文档', 'error'); return; }

    let W = 0, H = 0;
    try { W = Math.round(doc.width); H = Math.round(doc.height); } catch (e) { /* ignore */ }

    const fEl = $('upsFactor');
    const factor = fEl ? Number(fEl.value) : CFG.upscaleDefault;

    /* ---- 判断有没有选区（决定走哪条路） ---- */
    let box = null;
    try {
      box = await core.executeAsModal(async function () {
        return await readSelectionBox(W, H);
      }, { commandName: '读取选区' });
    } catch (e) { box = null; }
    if (box && box.fullCanvas) box = null;   // 全选视为没选

    const useRegion = !!box;

    /* ---- 处理模式 ----
     * region  : 只输出放大的选区（用户框哪就出哪，放大 N 倍）  ← 默认
     * enhance : 只增强选区后贴回原位（文档尺寸不变）
     * full    : 放大整张图（文档尺寸变大）
     * 前两种必须有选区；没有选区时一律走 full。
     */
    const mEl = $('upsMode');
    let mode = mEl && mEl.value ? mEl.value : CFG.upscaleMode;
    if (!useRegion && mode !== 'full') {
      log('未检测到选区，自动改为「放大整张图」模式', 'warn');
      mode = 'full';
    }

    setBusy(true, '准备中…');
    const tAll = Date.now();

    /* ---- 两条路的内存护栏 ---- */
    let geo = null;
    if (mode === 'region') {
      /* 只输出选区本身 —— 不裁边距、不合成，处理量最小 */
      const bw = box.right - box.left, bh = box.bottom - box.top;
      const midMP = bw * bh * 16 / 1e6;
      log('──────── 开始 AI 超分（只输出选区） ────────', 'info');
      log('选区 ' + bw + '×' + bh + '  位置 L' + box.left + ' T' + box.top, 'info');
      log('4 倍中间张量 ' + midMP.toFixed(1) + ' MP ≈ ' + (midMP * 12 / 1024).toFixed(2) +
          ' GB   （整图超分则要 ' + (W * H * 16 / 1e6).toFixed(0) + ' MP）', 'info');
      log('输出：' + (bw * factor) + '×' + (bh * factor) + ' 的选区放大图（' + factor + ' 倍）', 'info');
      if (midMP > CFG.upscaleMaxMP) {
        const msg = '选区太大：4 倍中间张量 ' + midMP.toFixed(0) +
          ' MP 超过上限 ' + CFG.upscaleMaxMP + ' MP。请缩小选区。';
        log('超分被拒绝：' + msg, 'error');
        setStatus('选区过大', 'failed');
        toast(msg.slice(0, 120), 'error');
        setBusy(false);
        return;
      }
    } else if (mode === 'enhance') {
      // 选区路：只算裁切块的 4 倍
      geo = computeInpaintGeometry(W, H, box, 0);   // targetSide=0 → 不缩放，取裁切框
      const cropMP = geo.crop.w * geo.crop.h / 1e6;
      const midMP = cropMP * 16;                    // 4 倍 → 16 倍像素
      log('──────── 开始 AI 超分（增强选区，贴回原位） ────────', 'info');
      log('选区 ' + box.w + '×' + box.h + '  位置 L' + box.left + ' T' + box.top, 'info');
      log('裁切块 ' + geo.crop.w + '×' + geo.crop.h + ' = ' + cropMP.toFixed(2) + ' MP', 'info');
      log('4 倍中间张量 ' + midMP.toFixed(1) + ' MP ≈ ' + (midMP * 12 / 1024).toFixed(2) +
          ' GB', 'info');
      if (midMP > CFG.upscaleMaxMP) {
        const msg = '选区太大：4 倍中间张量 ' + midMP.toFixed(0) +
          ' MP 超过上限 ' + CFG.upscaleMaxMP + ' MP。请缩小选区。';
        log('超分被拒绝：' + msg, 'error');
        setStatus('选区过大', 'failed');
        toast(msg.slice(0, 120), 'error');
        setBusy(false);
        return;
      }
      log('结果会贴回原位，文档尺寸不变，选区外像素零改动', 'info');
    } else {
      // 整图路：4 倍中间张量是原图的 16 倍，风险大
      const midMP = W * H * 16 / 1e6;
      const outMP = (W * factor) * (H * factor) / 1e6;
      log('──────── 开始 AI 超分（整图） ────────', 'info');
      log('原图 ' + W + '×' + H + '（' + (W * H / 1e6).toFixed(1) + ' MP）→ ' +
          factor + ' 倍 = ' + (W * factor) + '×' + (H * factor) + '（' + outMP.toFixed(1) + ' MP）', 'info');
      log('⚠ 模型固定 4 倍，所以要先算出 ' + midMP.toFixed(0) + ' MP 的中间张量' +
          '（约 ' + (midMP * 12 / 1024).toFixed(1) + ' GB）', 'warn');
      if (midMP > CFG.upscaleMaxMP) {
        const maxSrcMP = CFG.upscaleMaxMP / 16;
        const msg = '整图超分需要 ' + midMP.toFixed(0) + ' MP 的中间张量，超过安全上限 ' +
          CFG.upscaleMaxMP + ' MP（当前图 ' + (W * H / 1e6).toFixed(1) + ' MP）。' +
          '建议改为「框选一块区域」再点超分 —— 那样只处理选区，快几十倍。';
        log('超分被拒绝：' + msg, 'error');
        log('   （整图超分的安全上限约 ' + maxSrcMP.toFixed(1) + ' MP 的原图）', 'info');
        setStatus('图太大', 'failed');
        toast(msg.slice(0, 120), 'error');
        setBusy(false);
        return;
      }
      if (midMP > 100) {
        log('⚠ 中间张量较大，可能要几十秒到几分钟，且会占用大量内存。', 'warn');
        log('   如果失败，请框选一小块区域改用「仅选区」模式。', 'info');
      }
    }

    try {
      /* ① 连接与模型检查 */
      setStatus('连接 ComfyUI…', 'working');
      let info;
      try {
        info = await testConnection();
      } catch (e) {
        throw new Error('连不上 ComfyUI（' + errText(e) + '）。请确认已启动：' + CFG.server);
      }
      log('① 已连接 ComfyUI ' + info.version + ' / ' + info.device +
          '（内存/显存空闲 ' + (info.vramFree / 1073741824).toFixed(2) + ' GB）', 'ok');

      const ups = await listUpscalers();
      if (ups.indexOf(CFG.upscaleModel) < 0) {
        throw new Error('ComfyUI 里没有超分模型「' + CFG.upscaleModel +
          '」。请放到 ComfyUI\\models\\upscale_models\\ 下。当前可用: ' +
          (ups.join(', ') || '（空）'));
      }
      log('   超分模型: ' + CFG.upscaleModel, 'ok');

      /* ② 导出原图 */
      setStatus('导出图片…', 'working');
      log('② 导出原图…', 'info');
      const exported = await exportDocToPng('ps_upscale_src.png');
      log('   ' + (exported.bytes.length / 1048576).toFixed(1) + ' MB', 'ok');

      /* ③ 上传 */
      setStatus('上传到 ComfyUI…', 'working');
      const remoteImg = await uploadToComfy(exported.bytes, 'ps_upscale_src.png');
      log('③ 上传成功 → ' + remoteImg, 'ok');

      /* ④ 生成遮罩（增强模式需要）+ 组装工作流 */
      let wf;
      if (mode === 'region') {
        log('④ 只输出选区，无需遮罩', 'info');
        wf = buildUpscaleRegionWorkflow(box, remoteImg, factor);
      } else if (mode === 'enhance') {
        setStatus('生成遮罩…', 'working');
        log('④ 生成选区遮罩…', 'info');
        const m = await generateSelectionMaskCrop(W, H, box, 0);
        await writeBinaryFile('ps_upscale_mask.png', m.png);
        const remoteMask = await uploadToComfy(m.png, 'ps_upscale_mask.png');
        log('   遮罩 → ' + remoteMask, 'ok');
        wf = buildUpscaleSelectionWorkflow(geo, remoteImg, remoteMask);
      } else {
        log('④ 整图模式，无需遮罩', 'info');
        wf = buildUpscaleFullWorkflow(remoteImg, factor);
      }

      setStatus('AI 超分中…', 'working');
      log('⑤ 开始超分（模型内部 512×512 分块处理）…', 'info');
      log('   工作流节点数: ' + Object.keys(wf).length, 'info');
      const result = await runWorkflow(wf, function (sec) {
        setStatus('AI 超分中… ' + sec + ' 秒', 'working');
      });
      log('   完成，耗时 ' + result.seconds.toFixed(1) + ' 秒', 'ok');

      /* ⑤ 下载 */
      setStatus('下载结果…', 'working');
      log('⑥ 下载结果…', 'info');
      const outFile = await downloadResult(result.image, 'ps_upscale_out.png');
      log('   已保存到临时目录', 'ok');

      /* ⑥ 置入 */
      setStatus('置入图层…', 'working');
      log('⑦ 置入为新图层…', 'info');
      const before = doc.layers ? doc.layers.length : 0;
      await placeFileAsLayer(outFile);
      let after = before;
      try { after = getActiveDoc().layers.length; } catch (e) { /* ignore */ }

      const total = ((Date.now() - tAll) / 1000).toFixed(1);
      log('   图层数: ' + before + ' → ' + after, 'ok');
      if (mode === 'region') {
        log('   结果是**选区本身**放大 ' + factor + ' 倍：' +
            ((box.right - box.left) * factor) + '×' + ((box.bottom - box.top) * factor), 'ok');
        log('   已作为新图层置入（居中）。可自行移动到你想要的位置。', 'info');
      } else if (mode === 'enhance') {
        log('   结果与原图同为 ' + W + '×' + H + '，自动对齐；选区外像素零改动', 'ok');
      } else {
        log('   结果尺寸变为 ' + (W * factor) + '×' + (H * factor), 'ok');
      }
      log('──────── 完成，总耗时 ' + total + ' 秒 ────────', 'ok');

      setStatus('完成（' + total + ' 秒）', 'done');
      toast('超分完成，已置入新图层', 'ok');
      await refreshDocStatus();

    } catch (e) {
      const msg = errText(e);
      log('失败: ' + msg, 'error');
      if (/超时/.test(msg)) {
        log('提示：超时通常是内存不足导致换页。', 'warn');
        log('   ① 关掉其他占内存的程序后重试', 'warn');
        log('   ② 或者框选一小块区域再超分（只处理选区，快几十倍）', 'warn');
      }
      setStatus('失败', 'failed');
      toast(msg.slice(0, 120), 'error');
    } finally {
      setBusy(false);
    }
  }

  /* ==================================================================== *
   * §7 事件绑定与启动
   * ==================================================================== */
  async function onTestConnection() {
    setBusy(true, '测试连接…');
    log('测试 ComfyUI 连接…', 'info');
    log('  地址: ' + CFG.server, 'info');
    try {
      const info = await testConnection();
      log('连接成功', 'ok');
      log('  版本: ' + info.version, 'info');
      log('  设备: ' + info.device, 'info');
      log('  显存: ' + (info.vramFree / 1073741824).toFixed(2) + ' GB 空闲 / ' +
          (info.vramTotal / 1073741824).toFixed(2) + ' GB 总量', 'info');

      const models = await listBgModels();
      log('  可用去背景模型: ' + (models.length ? models.join(', ') : '（无，请放模型）'),
          models.length ? 'ok' : 'warn');
      const ckpts = await listCheckpoints();
      log('  可用重绘模型: ' + (ckpts.length ? ckpts.join(', ') : '（无）'),
          ckpts.length ? 'ok' : 'warn');
      const ups = await listUpscalers();
      log('  可用超分模型: ' + (ups.length ? ups.join(', ') : '（无）'),
          ups.length ? 'ok' : 'warn');

      setStatus('已连接', 'done');
      toast('ComfyUI 连接正常', 'ok');
    } catch (e) {
      const msg = errText(e);
      log('连接失败: ' + msg, 'error');
      setStatus('未连接', 'failed');

      // 区分"服务没开"和"地址写错"，直接给可操作的建议，不用去问别人
      const s = String(msg).toLowerCase();
      const looksLikeDown = s.indexOf('fail') >= 0 || s.indexOf('refus') >= 0 ||
                            s.indexOf('network') >= 0 || s.indexOf('connect') >= 0 ||
                            s.indexOf('denied') >= 0;
      log('', 'info');
      if (looksLikeDown) {
        log('这通常是 ComfyUI 没有运行。启动方法：', 'warn');
        log('  ① 双击桌面的「启动ComfyUI（推荐）.bat」', 'warn');
        log('  ② 等黑窗口出现 "To see the GUI go to: http://localhost:8188"', 'warn');
        log('  ③ 保持那个窗口开着，再回来点【测试连接】', 'warn');
        log('提示：ComfyUI 不是后台服务，关掉窗口它就停了。', 'info');
        log('提示：不要用 run_amd_gpu_enable_dynamic_vram.bat，', 'info');
        log('      那个参数会让 SDXL 输出彩色噪点。', 'info');
      } else {
        log('请检查地址是否正确：本机 ComfyUI 必须是 http://localhost:8188', 'warn');
        log('注意不能写成 127.0.0.1 —— UXP 不允许访问它。', 'warn');
      }
      toast('连接失败：ComfyUI 可能没有运行', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    // 绑定按钮
    const bind = function (id, fn) {
      const el = $(id);
      if (el) el.addEventListener('click', function () { fn().catch(function (e) {
        log('异常: ' + errText(e), 'error');
      }); });
    };

    bind('btnRemoveBg', removeBackground);
    bind('btnUpscale', upscaleImage);
    bind('btnTest', onTestConnection);
    bind('btnRefresh', refreshDocStatus);

    // 去背景的边缘处理方式
    const be = $('bgEdge');
    if (be) {
      be.value = CFG.bgEdgeMode;
      const bh = $('bgEdgeHint');
      const BH = {
        none: '遮罩直接作为透明通道。边缘锐利、主体完整，发丝细节保留最好。',
        soft: '先把边缘往里收缩几像素再羽化。边缘过渡更柔和，'
            + '但主体会略微变瘦、细节会软一点。'
      };
      const updB = function () {
        CFG.bgEdgeMode = be.value;
        if (bh) bh.textContent = BH[be.value] || '';
      };
      be.addEventListener('change', updB);
      updB();
    }

    // 超分处理方式：切换时更新说明文字
    const um = $('upsMode');
    if (um) {
      um.value = CFG.upscaleMode;
      const hint = $('upsModeHint');
      const HINTS = {
        region: '只输出你框选的那块区域，放大 N 倍，作为新图层置入。'
              + '处理量最小、最快。⚠ 需要先框选。',
        enhance: '只把选区的细节用 AI 重建，然后贴回原图原位 —— '
               + '文档尺寸不变，选区外像素零改动。⚠ 需要先框选。',
        full: '放大整张图，文档尺寸会变大。⚠ 模型固定 4 倍，'
            + '整图要先算出 16 倍像素的中间张量，大图非常吃内存甚至超时。'
      };
      const upd = function () {
        if (hint) hint.textContent = HINTS[um.value] || '';
      };
      um.addEventListener('change', upd);
      upd();
    }

    const clr = $('btnClear');
    if (clr) clr.addEventListener('click', function () {
      const box = $('log');
      if (box) box.innerHTML = '';
      const hint = $('logHint');
      if (hint) { hint.textContent = LOG_HINT_DEFAULT; hint.classList.remove('hint-new'); }
    });

    // 日志折叠/展开 —— 面板窄的时候很有用，折叠后能直接看到各功能按钮
    const tog = $('btnToggleLog');
    if (tog) tog.addEventListener('click', function () {
      const box = $('log');
      const hint = $('logHint');
      if (!box) return;
      const collapsed = box.classList.toggle('collapsed');
      tog.textContent = collapsed ? '展开' : '折叠';
      if (hint) hint.style.display = collapsed ? 'none' : '';
    });

    // 点日志提示 → 跳到最新一条
    const logHint = $('logHint');
    if (logHint) {
      logHint.style.cursor = 'pointer';
      logHint.addEventListener('click', function () {
        const box = $('log');
        if (box) box.scrollTop = box.scrollHeight;
        logHint.textContent = LOG_HINT_DEFAULT;
        logHint.classList.remove('hint-new');
      });
    }

    // 回到顶部
    const topBtn = $('btnTop');
    if (topBtn) topBtn.addEventListener('click', function () {
      const app = document.querySelector('.app');
      if (app) app.scrollTop = 0;
    });

    // 服务器地址输入框
    const inp = $('inpServer');
    if (inp) {
      inp.value = CFG.server;
      inp.addEventListener('change', function () {
        CFG.server = String(inp.value || '').replace(/\/+$/, '') || 'http://localhost:8188';
        inp.value = CFG.server;
        log('服务器地址已改为: ' + CFG.server, 'info');
        setStatus('未测试', '');
      });
    }

    // 临时工作目录（留空 = 自动）。改动后清掉缓存，下次读取生效。
    const wd = $('inpWorkDir');
    if (wd) {
      wd.value = CFG.workDir || '';
      wd.addEventListener('change', function () {
        CFG.workDir = String(wd.value || '').trim();
        cachedWorkDir = null;
        if (CFG.workDir) log('工作目录已改为: ' + CFG.workDir, 'info');
        else log('工作目录已改为: 自动（系统临时目录）', 'info');
      });
    }

    // 点击面板或获得焦点时刷新文档状态（不做任何轮询）
    document.addEventListener('click', function () { refreshDocStatus(); });
    try { window.addEventListener('focus', function () { refreshDocStatus(); }); } catch (e) { /* ignore */ }

    // 文档事件：只监听轻量通知，不轮询
    try {
      ['open', 'select', 'close', 'make'].forEach(function (ev) {
        try {
          action.addNotificationListener([{ event: ev }], function () { refreshDocStatus(); });
        } catch (e) { /* 该事件不支持就跳过 */ }
      });
    } catch (e) { /* ignore */ }

    await refreshDocStatus();
    log('ComfyUI 桥接插件已就绪', 'ok');
    log('目标服务器: ' + CFG.server, 'info');
    log('用法①：点【AI 去背景】→ 结果作为新图层置入', 'info');
    log('用法②：框选区域 → 填提示词 → 点【AI 局部重绘】', 'info');
    log('遮罩模块: ' + ((typeof window !== 'undefined' && window.RetouchMaskPng) ? '已加载' : '未加载（局部重绘不可用）'),
        (typeof window !== 'undefined' && window.RetouchMaskPng) ? 'ok' : 'error');
    setStatus('就绪', '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})();
