# ComfyUI 桥接插件 · README

> **v2.0.0 起已移除「AI 局部重绘」功能。**
> 原因：扩散模型在局部重绘上效果达不到预期（SD1.5 能力有限、
> SDXL/Flux 在这台核显上又太慢）。相关模型已一并删除。
> 现在插件只保留两个实测好用的功能：**AI 去背景** 和 **AI 放大超分**。

> 在 Photoshop 里一键调用**本机** ComfyUI 做 AI 修图，结果作为新图层置入。
> 不依赖任何云服务、不需要账号、不上传图片到互联网。

| 项目 | 说明 |
| --- | --- |
| 插件 ID | `com.local.ps.comfybridge` |
| 版本 | 1.1.0 |
| 类型 | Photoshop UXP 面板 |
| 功能 | **AI 去背景**（BiRefNet）· **AI 放大超分**（RealESRGAN） |
| 前置要求 | 本机运行 ComfyUI（默认 `http://localhost:8188`） |
| 网络行为 | **只访问 `localhost`**，不访问任何公网地址 |

---

## 一、安装

### 1. 安装插件（把文件夹放进 Plug-ins）

与「本地修图工具箱」同样方式：

```
D:\photo shop\Adobe Photoshop 2025\Plug-ins\com.local.ps.comfybridge\
```

必须的结构（`manifest.json` 在第一层）：

```
com.local.ps.comfybridge\
├── manifest.json
├── index.html
├── css\style.css
├── js\main.js
├── js\maskpng.js       ← 纯 JS 的 PNG 编码器（生成遮罩用）
└── icons\plugin.png (+@1x/@2x)
```

放好后**完全退出 Photoshop 再启动**，菜单：**增效工具（Plug-ins）→ ComfyUI 桥接**

### 2. 确认 ComfyUI 在运行

启动方式：

```powershell
cd D:\ComfyUI\ComfyUI_windows_portable
.\run_amd_gpu_enable_dynamic_vram.bat
```

看到 `To see the GUI go to: http://localhost:8188` 就绪。

### 3. 确认模型已就位

| 功能 | 模型 | 放置目录 | 大小 |
| --- | --- | --- | --- |
| AI 去背景 | `birefnet.safetensors` | `ComfyUI\models\background_removal\` | 424 MB |

下载地址（实测速度）：

```
# ModelScope 最快（实测 12 MB/s）
https://modelscope.cn/api/v1/models/AI-ModelScope/stable-diffusion-inpainting/repo?Revision=master&FilePath=sd-v1-5-inpainting.ckpt

# HuggingFace 镜像（BiRefNet，hf-mirror 约 8 MB/s）
https://hf-mirror.com/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors
```

> HuggingFace 直连在国内不可达。`gh-proxy.com` 只能代理 GitHub，代理 HF 会 404。

放好后**重启 ComfyUI**（模型列表只在启动时扫描）。

---

## 二、功能一：AI 去背景

1. 在 Photoshop 打开图片
2. 打开面板：**增效工具 → ComfyUI 桥接**
3. （首次建议）点 **【测试连接】**，确认显示 ComfyUI 版本、设备和显存
4. 点 **【AI 去背景】**
5. 等待约 **20~30 秒**（取决于图片大小），PS 里会多出一个新图层 = 抠好的主体（透明背景）

**原图层完全不受影响**，结果始终作为新图层置入。

### 面板说明

| 区域 | 说明 |
| --- | --- |
| 状态条 | 就绪 / 连接中 / AI 推理中…xx秒 / 完成（总耗时）/ 失败 |
| 文档信息 | 文件名 · 尺寸 · 当前图层名 |
| ComfyUI 地址 | 可修改，默认 `http://localhost:8188` |
| 运行日志 | 分色显示：蓝=进度 绿=成功 黄=警告 红=错误 |

### 实测性能（AMD Ryzen AI 9 H 365 + Radeon 880M 核显）

| 图片 | 耗时 |
| --- | --- |
| 5568×3712（20.7 MP） | **约 23 秒** |

其中 AI 推理约 13~18 秒，其余为文件导出/上传/下载/置入。

---

## 三、工作原理

```
① 复制当前文档（不干扰原文档）
② 用 fs.createSessionToken() 把副本存成临时 PNG
      D:\ComfyUI\bridge-tmp\ps_input.png
③ 手工拼 multipart 上传给 ComfyUI  → ComfyUI\input\ps_input.png
④ POST /prompt 提交去背景工作流，轮询 /history 等结果
⑤ GET /view 下载结果 PNG          → D:\ComfyUI\bridge-tmp\ps_result.png
⑥ 用会话令牌 placeEvent 置入为新图层（PNG 保留 alpha 透明通道）
```

### 使用的工作流

```json
{
  "1": { "class_type": "LoadImage", "inputs": { "image": "ps_input.png" } },
  "2": { "class_type": "LoadBackgroundRemovalModel", "inputs": { "bg_removal_name": "birefnet.safetensors" } },
  "3": { "class_type": "RemoveBackground", "inputs": { "bg_removal_model": ["2", 0], "image": ["1", 0] } },
  "8": { "class_type": "InvertMask", "inputs": { "mask": ["3", 0] } },
  "4": { "class_type": "JoinImageWithAlpha", "inputs": { "image": ["1", 0], "alpha": ["8", 0] } },
  "5": { "class_type": "SaveImage", "inputs": { "images": ["4", 0], "filename_prefix": "PS_Bridge/cutout" } }
}
```

> **注意 `InvertMask` 不能省。** BiRefNet 输出「白=前景」，而 `JoinImageWithAlpha`
> 把黑当透明，方向相反。不反转会得到「白色剪影 + 保留背景」。

### 遮罩是怎么生成的（关键设计）

**方法：纯色图层法** —— 利用 Photoshop 的一个特性：

> **有选区时，创建纯色图层会把选区自动变成该图层的图层蒙版。**

所以：

```
① 记下 activeHistoryState（用于最后还原）
② flatten → 建黑色纯色图层 → 建白色纯色图层 → 白色移到底部
③ imaging.getPixels 读裁切区域的像素  →  得到遮罩
④ 恢复 activeHistoryState  →  文档完全还原
⑤ 用纯 JS 编码成 PNG，并翻转极性（PS 读出来是反的）
```

**为什么用这个方法**：它**支持套索、快速选择、魔棒画出的任意形状**。
早期版本用「读选区包围盒 → 画矩形」，不规则选区会被当成它的外接矩形，
遮罩不准确。

**为什么要自己写 PNG 编码器**：UXP 的 `imaging.encodeImageData`
**永远输出 JPEG，不支持 alpha**，而遮罩必须是 PNG。所以见 `js/maskpng.js`：
- PNG = 签名 + IHDR + IDAT + IEND
- IDAT 是 zlib 流，**zlib 允许「存储块(stored)」即完全不压缩** → 无需第三方库
- 已用 PIL 复检 CRC、adler32、尺寸全部正确

**为什么遮罩只生成裁切区域大小**：只读裁切区域的像素（不是整张图），
PS 侧读取量从 20.7 MP 降到约 2.8 MP，快得多，且能保留选区边缘的抗锯齿。

### 这条路上试错过的方案（都已排除）

| 途径 | 结果 |
| --- | --- |
| batchPlay `selectAll` | ❌ 命令"<未知的>"当前不可用 |
| batchPlay `set selection` | ❌ 命令"设置"当前不可用 |
| batchPlay `make document` | ❌ 命令"建立:"当前不可用（-25920） |
| batchPlay `make channel` | ❌ 命令"建立"当前不可用 |
| DOM `doc.selection.select()` | ❌ TypeError: is not a function |
| duplicate 后副本带选区 | ❌ 副本不携带选区 |
| **`make contentLayer` + `solidColorLayer`** | ✅ **可用（最终采用）** |
| **读选区**（`get selection` / `selection.bounds`） | ✅ 可用 |
| `fill` / 建删图层 / 导出文档 | ✅ 可用 |

## 四、开发时踩过的坑（重要，改代码前必读）

UXP 的文档质量很差，以下全部是**在真机上实测**得出的结论。

### 1. 网络权限：`127.0.0.1` 不被识别

```
[失败] http://127.0.0.1:8188 → Permission denied. Manifest entry not found.
[OK]   http://localhost:8188 → 连接成功
```

manifest 里 `network.domains` 写 `["127.0.0.1", "localhost"]` 时，
**访问 `127.0.0.1` 会被拒绝**。代码里必须统一用 `localhost`。
（最终改为 `"domains": "all"`，代码只用 localhost。）

### 2. `manifest.json` 不能有 UTF-8 BOM

```
有 BOM:   EF BB BF 7B 0A 20
正常:     7B 0A 20 20 22 6D
```

**PowerShell 的 `Set-Content -Encoding UTF8` 会自动加 BOM**，导致 UXP 解析失败、
插件从菜单里消失（且没有任何提示）。必须用：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

### 3. `manifest.json` 不能有未知字段

连 `"_注释_xxx"` 这种自定义字段都会被拒，整个插件被丢弃。
**注释只能写在代码或文档里。**

### 4. `label` 不能用下划线 locale

```json
"label": { "default": "xxx", "zh_CN": "xxx" }   ← 错，插件消失
"label": { "default": "xxx" }                    ← 对
```

UXP 要求连字符（`zh-CN`），下划线会导致 `Invalid format for label`。

### 5. 面板里绝对不能放 `setInterval`

曾导致 **Photoshop AppHang（无响应）**，事件日志记录 `AppHangB1`，
崩溃转储 1.2 GB。面板状态更新要改成"用户操作时被动响应"。

### 6. 图层信息必须用 batchPlay

```js
doc.activeLayer    // → undefined
doc.activeLayers   // → Cannot convert a Symbol value to a string
doc.layers         // → 可以（只给长度）

// 正确做法：batchPlay 一次拿整个图层对象
batchPlay([{ _obj: 'get', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }])
// → { name, layerID, bounds, layerKind, layerSection, opacity, visible, ... }
```

### 7. 文件操作必须用会话令牌，不能传路径

```js
// 错：batchPlay save / placeEvent 传路径
{ _obj: 'save', in: { _path: 'D:\\xxx.png', _kind: 'local' } }
// → Error: invalid file token used

// 对：先用 fs.createSessionToken 拿令牌
const file = await workDir.createFile('x.png', { overwrite: true });
const token = fs.createSessionToken(file);
{ _obj: 'save', in: { _path: token, _kind: 'local' } }
```

### 8. ComfyUI 的 COMBO 字段有两种返回格式

```
background_removal: ["COMBO", { options: [...] }]      → 值在 [1].options
checkpoints:        [{ value: [...] }, { tooltip }]    → 值在 [0].value
```

两种都要兼容（见 `listCheckpoints()`）。

### 9. UXP 缺失的 API（都验证过不存在）

| API | 状态 |
| --- | --- |
| `TextEncoder` | ❌ 不存在 → 自己写 ASCII 编码器 |
| `createImageBitmap` | ❌ 不存在 |
| `imaging.decodeImageData` | ❌ 不存在 |
| `imaging.createImageDataFromBase64String` | ❌ 不存在 |
| `ctx.getImageData`（canvas） | ❌ 不存在 |
| `imaging.encodeImageData` | ⚠️ 存在，但**永远输出 JPEG，不支持 alpha** |

**结论：不要在 JS 端处理"解码"图片像素。**
需要生成图片时（如本插件的遮罩）可以自己手写编码器（见 `js/maskpng.js`）。

### 10. 其它

- `doc.width` / `doc.height` 在 UXP 里直接是像素数（不是 1/100000 单位）
- `getPixels` 返回包装对象：`{ imageData: {width, height, colorSpace}, sourceBounds, level }`
- 面板里的文字**选中/复制不可靠**，需要输出信息时直接写文件
- 多张图上传时 ComfyUI 会自动加序号后缀（`a (1).png`），要用响应里的 `name`

### 11. 读选区可以，写选区不行 —— 但「纯色图层法」能绕过去

```js
// 读：一直正常
batchPlay([{ _obj: 'get', _target: [{_property:'selection'}, {_ref:'document', ...}] }])
// → { _obj:'selection', top, left, bottom, right }

// 直接"写"选区：全部被拒
batchPlay([{ _obj:'selectAll', ... }])                  // → 命令"<未知的>"当前不可用
batchPlay([{ _obj:'set', to:{_obj:'rectangle',...} }])  // → 命令"设置"当前不可用
doc.selection.select({top,left,bottom,right})           // → TypeError: is not a function
batchPlay([{ _obj:'make', new:{_obj:'document'} }])     // → 命令"建立:"当前不可用（-25920）
batchPlay([{ _obj:'make', new:{_obj:'channel'} }])      // → 命令"建立"当前不可用

// ✅ 但这条能用（本项目最终采用的方案）：
batchPlay([{ _obj:'make', _target:[{_ref:'contentLayer'}],
             using:{_obj:'contentLayer', type:{_obj:'solidColorLayer',
                    color:{_obj:'RGBColor', red:255, green:255, blue:255}}} }])
```

**关键洞察：有选区时，Photoshop 会自动把选区变成纯色图层的图层蒙版。**

所以只要有选区，建两个纯色图层（黑+白）再读像素，就得到了**精确的遮罩图**，
而且**支持套索、快速选择、魔棒画出的任意形状**。

### 12. 纯色图层法的三个实测要点

**① `imaging.getPixels` 与 `activeHistoryState` 必须在 modal 作用域内**

```
The requested functionality is only allowed from inside a modal scope.
```

所以「建图层 + 读像素 + 恢复历史」要放进**同一个** `executeAsModal`：

```js
await core.executeAsModal(async () => {
  const d = app.activeDocument;
  const saved = d.activeHistoryState;
  let info = null, err = null;
  try {
    await batchPlay(createFillLayersAction(), { synchronousExecution: true });
    info = await readPixels(d.id, bounds);          // ← 必须在里面
  } catch (e) { err = e.message; }
  finally {
    try { d.activeHistoryState = saved; }           // ← 也必须在里面
    catch (e2) { if (!err) err = e2.message; }
  }
  if (err) throw new Error(err);
  return info;
}, { commandName: '生成选区遮罩' });
```

**② 读出的像素极性是反的**

实测：**选区形状 = 黑(0)，选区外 = 白(255)**。
而 ComfyUI 需要「白 = 要重绘」。

YAO 代码里的 `_createFillLayersAction(invert)` 会追加 `{_obj:"invert"}`，
但**实测无效** —— 那两层是纯色**内容图层**（像素是生成的），invert 命令对它们不起作用，
加不加 invert 输出字节完全相同。

**所以极性翻转在自己代码里做**（`encodeGrayFromRaw2(..., invert=true)`）。

**③ 用历史状态还原，比"加图层再删图层"更干净**

```js
finally { d.activeHistoryState = saved; }   // 连 flatten 都能干净撤销
```

### 13. `applyAlpha` 可以不用

`getPixels` 的 `applyAlpha: true/false` 实测**结果完全一样**
（只是 components 为 3 或 4）。遮罩只看明暗，用 `false` 更简单。

### 14. 判断"有没有选区"不能用 `selection.path`

```js
// 错：有选区时返回的是矩形描述符，没有 path 字段 → 条件永远为假
if (sel.path && sel.path.length) { /* 有选区 */ }

// 对：用 doc.selection.bounds 更直接
const b = doc.selection.bounds;
if (b && b.left < b.right && b.top < b.bottom) { /* 有选区 */ }
```

### 15. 面板滚不动？`height:100%` 在 UXP 里解析不出来

UXP 面板**默认不滚动**，内容超出后会被直接裁掉。而且 `height:100%` 的百分比
高度链在 UXP 里**算不出真实面板高度**，于是：

```
html,body{height:100%}  →  算不出来
.app{height:100%}       →  也没有确定高度
.app{overflow-y:auto}   →  永远不触发滚动
```

**正确写法：视口单位 + 绝对定位**

```css
html, body {
  height: 100%;      /* 兜底 */
  height: 100vh;     /* UXP 支持，且是面板实际高度 */
}
.app {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;   /* 四边贴齐 = 拿到确定高度 */
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
```

### 16. 【最隐蔽的坑】flex 子项默认会被压扁，而不是溢出

**这是"一缩小文字就挤成一团、而且不滚动"的根因。**

`.app` 是 flex 列布局，而 **flex 子项的 `flex-shrink` 默认为 1** ——
意思是"容器高度不够时把子项压扁"。结果：

```
内容超出 → 不是溢出产生滚动条
         → 而是所有卡片被压缩，文字挤在一起
```

**一条规则解决**：

```css
.app > * { flex: none; }   /* 即 flex-shrink:0，子项保持自身高度 */
```

设好之后，子项总高度超出 `.app` → 自然触发 `overflow-y:auto` 的滚动。
**加这一条之前，"挤压"和"不滚动"两个问题同时存在，且都由它引起。**

### 17. 窄面板下的文字挤压：先查 `min-width`

flex 子项默认 **`min-width: auto`（不允许收缩到内容宽度以下）**，
这是"文字溢出/互相挤压"最常见的根因。修法是显式给 `min-width: 0`：

```css
.card, .field, .input, .log-msg, .card-title > span:first-child { min-width: 0; }
```

配套措施（本插件用的方案）：

| 措施 | 作用 |
| --- | --- |
| `overflow-wrap: anywhere` | 长英文/路径可在任意位置断行，不撑破容器 |
| `flex-wrap: wrap` | 行内元素窄了就换行，而不是硬挤 |
| `.idx { flex: none }` | 徽标不被压扁 |
| 媒体查询分档（≤340 / ≤290 / ≤250px） | 逐级缩字、页脚按钮改竖排 |

### 18. 日志自动滚动不要强制拽到底

面板里日志每来一条就 `scrollTop = scrollHeight`，会导致用户**想往上翻看历史时
被不断拽回底部**。正确做法是先判断用户是否本来就在底部：

```js
const atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 24;
box.appendChild(line);
if (atBottom) box.scrollTop = box.scrollHeight;
else showNewLogHint();     // 只提示，不打断
```

---

## 五、故障排查

### 插件在菜单里找不到

按顺序检查：

1. `D:\photo shop\Adobe Photoshop 2025\Plug-ins\com.local.ps.comfybridge\manifest.json` 是否存在
2. **manifest 有没有 BOM**（最隐蔽的坑）
3. 是否完全退出 PS 后重启（插件只在启动时扫描一次）
4. 跑自检脚本（会自动查上述所有问题）：

```powershell
& 'C:\ps自制插件\tools\check_plugin.ps1'
```

5. 仍找不到就读 UXP 日志，里面会写明原因：

```powershell
$log = Get-ChildItem "$env:APPDATA\Adobe\Adobe Photoshop 2025\Logs" -Filter 'UXPLogs_*.log' |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
Select-String -Path $log.FullName -Pattern 'comfybridge|Failed to parse|Invalid format' -Encoding UTF8 |
       ForEach-Object { $_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)) }
```

### 面板提示「连不上 ComfyUI」

- ComfyUI 是否在运行？（黑色命令行窗口是否开着）
- 地址是否为 `http://localhost:8188`（**不能写 `127.0.0.1`**）
- 浏览器能否打开 `http://localhost:8188`

### 提示「ComfyUI 里没有模型」

把模型放到对应目录，然后**重启 ComfyUI**（模型列表在启动时扫描）：

```
models\background_removal\birefnet.safetensors
models\checkpoints\sd-v1-5-inpainting.ckpt
```

### 抠出来是「白色剪影 + 保留背景」

说明 `InvertMask` 那一步没生效。检查工作流里 `JoinImageWithAlpha` 的
`alpha` 输入是否指向 `["8", 0]`（InvertMask）而不是 `["3", 0]`。

---

## 六、后续可以加什么

当前只实现了去背景。按同样架构可以扩展：

| 功能 | 需要额外下载 | 说明 |
| --- | --- | --- |
| 放大超分 | RealESRGAN_x4plus（64 MB） | 分块处理，需要额外做分块调度 |
| 厚涂等风格转换 | 绘画模型 + LoRA | 全图重绘，核显较慢（5~20 分钟/张） |

扩展方式：在 `js/main.js` 里新增一个 workflow 构造函数，
复用现有的 `exportDocToPng` → `uploadToComfy` → `runWorkflow` → `downloadResult` → `placeFileAsLayer` 链路即可。

---

## 七、相关文件位置

| 用途 | 路径 |
| --- | --- |
| 插件源码 | `C:\ps自制插件\com.local.ps.comfybridge\` |
| 已安装 | `D:\photo shop\Adobe Photoshop 2025\Plug-ins\com.local.ps.comfybridge\` |
| 可用版本备份 | `C:\ps自制插件\backup_ComfyUI桥接可用版本\` |
| 插件自检脚本 | `C:\ps自制插件\tools\check_plugin.ps1` |
| ComfyUI | `D:\ComfyUI\ComfyUI_windows_portable\` |
| 临时文件中转 | `D:\ComfyUI\bridge-tmp\` |
| 部署与踩坑记录 | `C:\ps自制插件\ComfyUI部署记录.md` |
