# dsh-glass-skin — 亚克力/玻璃外观

把 DeepSeek Harness 的界面换成**半透明亚克力（acrylic）/ 玻璃**材质，让桌面透过窗口可见，并与现有的主题类插件叠加共存而不是覆盖它们。

它由两部分组成，**可以只用第一部分**：

| 部分 | 作用 | 是否需要改 DSH 安装 |
| --- | --- | --- |
| **1. `dsh-glass-skin` 插件** | 把界面各层表面变成半透明；提供设置开关 | 不需要，纯插件 |
| **2. `tools/dsh-glass-desktop.mjs`** | 让 Electron 主窗口获得 Windows 原生 acrylic 背景（真正的桌面模糊） | 需要，改 `app.asar` |

> 只装插件、不打窗口补丁时：表面会变半透明，但**看不到桌面**（窗口仍然不透明）。
> 只打补丁、不装插件时：窗口有原生 acrylic 模糊，但界面自己画的不透明底色仍会盖住它。
> 两者都要，才有“透出桌面”的完整效果。

---

## 一、插件

已安装到 `desktop` profile，插件行 id 为 `glass-skin`。

开关位置：**设置 → 通用 → 玻璃皮肤**（在“外观”“字号大小”之后）。

### 它改了哪些东西

只改 4 个 token，且都保留当前主题的颜色作为来源：

```css
--dsw-alias-bg-base              /* 应用底色 */
--dsw-specific-sidebar-fill      /* 侧栏 */
--dsw-alias-bg-layer-1           /* 一级浮起表面 */
--dsw-alias-markdown-code-block  /* 代码块 */
```

每个值都写成 `color-mix(in srgb, <当前主题的颜色> N%, transparent)`，其中 `N` 因明/暗色而不同。

### 为什么这样能和现有主题插件共存

DSH 的主题系统在每次主题变化时，把 token 以**内联样式**写到 `document.body` 上。内联样式的优先级高于任何样式表，所以一个“自己写 CSS 覆盖颜色”的插件必然会被主题系统反复盖掉，或者反过来把别的主题打坏。

本插件走的是主题服务的**协作通道** `ctx.theme.overrideTokens(source, tokens)`：

- 它是主题系统自己的**叠加层**（overlay layer），按注册顺序叠加在活动主题之上，不修改主题注册表；
- 主题切换、明暗切换、系统外观变化时，叠加层被重新合成，所以不会丢；
- 颜色来源取自**主题注册表里的定义**，不是合成后的快照——否则每次切换都会把上一层的半透明再乘一次，表面会越来越淡直到消失；
- 因为只改透明度、不改色相，第三方主题（`dsh-theme-mineradio`、`dsh-official-homepage-theme`、`open-sea-skin` 等）的颜色会被继承下来，玻璃效果叠在它们之上，而不是替换它们。

它还遵守 `prefers-reduced-transparency: reduce`：系统要求减少透明度时自动停用，并在设置行里说明原因。

---

## 二、窗口补丁（可选，但“透视桌面”必须要它）

`tools/dsh-glass-desktop.mjs` 给主窗口注入两个选项：

```js
backgroundColor: "#00000000", backgroundMaterial: "acrylic",
```

### 实测依据（Electron 44.7.0 / Windows 11 26300）

用一个纯洋红 + 高频棋盘格的背景，逐像素采样窗口内部，结果是：

| 窗口选项 | 桌面是否透出 | 是否真模糊 | 原生窗口阴影 |
| --- | --- | --- | --- |
| `backgroundMaterial:"acrylic"` | ✅ 透出 | ✅ 是（棋盘被抹平，亮度标准差 0） | ✅ 保留（约 30/28/18/74 px） |
| `transparent:true` + `acrylic` | ✅ 透出 | ✅ 是 | ❌ 坍缩到约 2 px |
| `transparent:true`（无材质） | ✅ 透出 | ❌ 否（棋盘清晰可见） | ❌ 约 2 px |
| `backgroundMaterial:"mica"` | ❌ 不透出 | — | ❌ |
| 不透明底色（对照） | ❌ | — | ✅ |

所以默认用**第一种**：`acrylic` + 全透明底色，**不**设 `transparent: true`。

这也正是 DSH 自己欢迎窗口用的写法（那扇窗口本来就带 `backgroundMaterial: "acrylic"`），属于应用自身已经验证过的路径。加 `transparent: true` 虽然也能透，但会牺牲窗口阴影，大窗口会失去和桌面的边界感。

### 用法

```bash
node tools/dsh-glass-desktop.mjs status     # 看当前状态
node tools/dsh-glass-desktop.mjs enable     # 打补丁（先退出 DSH）
node tools/dsh-glass-desktop.mjs disable    # 还原
```

打完后**完全退出再重开** DSH（含托盘图标）才生效。

- 改的是 `lib/main.js` 里 `createWindow()`，**只动主窗口**；二级窗口和对话框保持不透明。
- 补丁是**等长替换**：在 `new BrowserWindow({...})` 里插入 N 字节，再从上方一段纯注释 JSDoc 里删掉同样 N 字节，所以 asar 总大小不变、header 不变、所有 entry 偏移不变。
- 写入前有 5 项自检（大小不变 / header 字节一致 / 全 entry 偏移不变 / 仅 `lib/main.js` 内容变化 / 提取后 `node --check` 通过 / 标记恰好出现一次）。
- 首次 `enable` 会在同目录备份 `app.asar.dsh-glass-backup` 与 `app.asar.dsh-glass.json`（记录原始 sha256）。`disable` 会先校验 sha256 再还原，备份保留。
- 校验失败时**绝不**替换目标文件，原文件保持不变。

### 两个真实限制

1. **应用更新会覆盖 `app.asar`**，补丁随之失效。更新后重新跑 `enable` 即可；如果版本变了导致锚点位置改变，工具会明确报错而不会瞎猜。
2. **运行中的 DSH 会锁住 `app.asar`**，所以 `enable` 必须在 DSH 退出后执行。若在运行时执行，工具会打印当前状态的说明并保留一份已验证的临时副本，原文件不受影响。

---

## 文件清单

```
plugins/dsh-glass-skin/
  package.json          dsh.bundle.patch + dsh.client
  cordis.patch.yml      插入 id 为 glass-skin 的 bundle 行
  index.js              Host 半边（空实现，外观全部在浏览器端）
  client.js             玻璃 token 叠加层 + 设置行（React，无外部依赖）
  locale/{zh,en}.json   插件市场的标题与描述
  icon.svg              原创图标（玻璃窗格）
tools/
  dsh-glass-desktop.mjs 窗口补丁工具
  README.md             工具说明
```
