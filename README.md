# Photoshop UXP 本地修图插件

> **只想下载使用？** 看 [安装说明.md](安装说明.md) —— 里面有下载地址（含国内镜像）和逐步安装指南。
>
> 上不了 GitHub 的话，用这个镜像直链：
> `https://gh-proxy.com/https://github.com/cause0210/ps-uxp-plugins/archive/refs/heads/main.zip`

两个**完全本地运行**的 Photoshop UXP 面板插件，不需要登录 Adobe 账号，
把文件夹放进 `Plug-ins` 目录即可使用。

| 插件 | 说明 | 依赖 |
| --- | --- | --- |
| **本地修图工具箱** | 清除杂物、抚平褶皱。纯本地算法，秒级完成 | 无 |
| **ComfyUI 桥接** | AI 去背景、AI 放大超分 | 需要本机运行 ComfyUI |

- 宿主：Adobe Photoshop **23.0.0 及以上**（开发环境为 26.5）
- 平台：Windows（ComfyUI 桥接的启动脚本是 `.bat`）
- 语言：界面与文档均为中文

---

## 一、本地修图工具箱 `com.local.ps.retouchkit`

**不依赖任何外部程序**，装进 PS 就能用。所有运算在插件内完成（WebAssembly + 自写图像算法），图片不会离开你的电脑。

主要功能：

- **清除杂物** —— 框选要消除的对象，用周围像素智能填补
- **抚平褶皱** —— 保留织物纹理的同时压平褶皱，不会糊成一片

结果写入新图层，原图层不动，文档分辨率不变。

详见 [`com.local.ps.retouchkit/README.md`](com.local.ps.retouchkit/README.md)

---

## 二、ComfyUI 桥接 `com.local.ps.comfybridge`

把 Photoshop 的选区与 ComfyUI 打通：**在 PS 里框选 → 插件把图和遮罩发给本机 ComfyUI → 结果自动置入为新图层。**

主要功能：

| 功能 | 模型 | 实测耗时 |
| --- | --- | --- |
| **AI 去背景** | BiRefNet | 约 23 秒（20.7 MP） |
| **AI 放大超分** | RealESRGAN_x4plus | 15~70 秒 |

特点：

- **超分会按选区走** —— 框选后只处理那一块，处理量能小几十倍
- 超分提供三种方式：只输出放大的选区 / 增强选区后贴回原位 / 放大整图
- 去背景提供两种边缘处理：标准（锐利）/ 柔和（收缩+羽化）
- 完全离线，图片只在你本机的 `localhost` 之间传递

详见 [`com.local.ps.comfybridge/README.md`](com.local.ps.comfybridge/README.md)

---

## 三、安装

### 通用步骤

1. 找到 Photoshop 的 `Plug-ins` 目录，通常在：

   ```
   <Photoshop 安装目录>\Plug-ins\
   ```

   例如 `D:\Adobe Photoshop 2025\Plug-ins\`

2. 把 `com.local.ps.retouchkit`（或 `com.local.ps.comfybridge`）**整个文件夹**复制进去

3. **完全退出并重新启动 Photoshop** —— 插件目录只在启动时扫描一次

4. 打开任意图片 → 菜单 **增效工具(Plug-ins)** → 选择插件

> **找不到插件？** 最常见的原因是 `manifest.json` 被编辑器加上了 UTF-8 BOM。
> 用记事本"另存为 UTF-8"会把 BOM 写进去；请用 VS Code 等编辑器选择
> **"UTF-8（无 BOM）"**。详见插件 README 的踩坑记录。

### ComfyUI 桥接的额外准备

除插件外还需要：

1. **本机运行 ComfyUI**（默认地址 `http://localhost:8188`）
2. **下载两个模型**放入 ComfyUI：

   | 模型 | 放置位置 | 大小 |
   | --- | --- | --- |
   | `birefnet.safetensors` | `ComfyUI\models\background_removal\` | 424 MB |
   | `RealESRGAN_x4plus.pth` | `ComfyUI\models\upscale_models\` | 64 MB |

启动 ComfyUI 后，回到 PS 点插件里的【测试连接】即可验证。

---

## 四、为什么不用 UXP Developer Tool

这两个插件的安装方式是**直接复制文件夹**，不需要：

- Adobe 开发者账号登录
- UXP Developer Tool
- 任何形式的签名或打包

只要 `manifest.json` 合法（无 BOM、无未知字段、locale 格式正确），
Photoshop 启动时就会自动加载。

---

## 五、开发踩坑记录

UXP 有不少反直觉的限制，两个插件的 README 里记录了 **20 多条实测踩坑**，
包括：

- `manifest.json` 不能有 BOM / 未知字段 / 下划线 locale
- 面板里绝对不能用 `setInterval`（会把 Photoshop 挂死）
- `127.0.0.1` 在 UXP 网络权限里不被识别，必须用 `localhost`
- 文件操作必须用 `createSessionToken`，不能直接传路径
- `imaging.encodeImageData` 只能输出 JPEG，需要自写 PNG 编码器
- 布局：`height:100%` 在 UXP 里解析不出来，要用 `100vh`
- flex 子项默认会被压扁而不是溢出

改代码前建议先读一遍，能省很多时间。

---

## 六、许可

MIT License，见 [LICENSE](LICENSE)。
