# dsh-glass-skin

给 [DeepSeek Harness](https://github.com/deepseek-ai) 换上**亚克力／磨砂玻璃**外观：界面半透明，能**看见桌面**，并叠加在你当前主题之上。

```bash
npx github:InkStain258/dsh-glass-skin
```

一条命令，插件和窗口材质一起装好。

> **Windows 11** 是完整支持的平台（原生 acrylic）。macOS 上插件部分可用，走系统自带的 vibrancy。Linux 会跳过窗口补丁。

---

## 效果由三层组成

| 层 | 作用 |
| --- | --- |
| **原生窗口材质** | 由系统模糊窗口背后的桌面（Windows 上是 acrylic） |
| **玻璃表面** | 应用自己的底色变成 70–82% 透明，但保留当前主题的颜色 |
| **磨砂模糊** | 30px 的背景模糊，让文字压在花哨壁纸上也能读 |

**能和你现有的主题插件共存**：它不替换主题，而是叠在上面。Mineradio、官方主页主题、open-sea-skin 以及自定义主题都保有自己的配色，只改变透明度。

---

## 安装

### 一条命令

```bash
npx github:InkStain258/dsh-glass-skin
```

或者克隆后本地执行：

```bash
git clone https://github.com/InkStain258/dsh-glass-skin.git
cd dsh-glass-skin
node scripts/install.mjs
```

**能先关掉 DeepSeek Harness 最好。** 安装要改 `app.asar`，而运行中的应用会锁住这个文件。如果它开着，安装程序会明确告诉你，并且**不动你的任何文件**；退出后重跑即可。

然后**重启应用**。

### 参数

```bash
node scripts/install.mjs --dry-run      # 只看会发生什么，不改动任何东西
node scripts/install.mjs --no-patch     # 只装插件：表面半透明，但看不到桌面
node scripts/install.mjs --no-plugin    # 只打窗口补丁
node scripts/install.mjs --asar <路径>   # 自动找不到 app.asar 时手动指定
node scripts/install.mjs --uninstall    # 全部撤销
```

---

## 卸载

```bash
npx github:InkStain258/dsh-glass-skin --uninstall
```

也可以只关掉效果：**设置 → 通用 → 玻璃皮肤**。表面会立刻恢复，窗口材质保留。

想连窗口也恢复出厂状态，用 `--uninstall`，它会拿安装时留下的**逐字节备份**还原。

---

## 调整外观

所有表面的数值都在 `plugin/client.js` 顶部一个数组里：

```js
const GLASS_TOKENS = [
  { name: '--dsw-alias-bg-base',         light: 30, dark: 22, … },
  { name: '--dsw-specific-sidebar-fill', light: 26, dark: 18, … },
  …
]
```

`22` 的意思是「这块表面保留自身颜色的 22%」，也就是**透出 78% 的桌面**。调高更实、文字更清楚；调低更玻璃。

模糊强度是同一个文件里的一行：

```css
backdrop-filter: blur(30px) saturate(140%);
```

改完重启应用（如果你在用 `dsh web` 且开着监听，HMR 会自动加载）。

---

## 为什么必须打补丁

只有一层能做成纯插件。

**表面**是纯插件：DSH 允许客户端插件通过 `ctx.theme.overrideTokens()` 叠一层 token，这是主题系统自己的协作通道——每次换配色都会重新合成，所以既不会被覆盖，也不会打坏别的主题。

**窗口材质做不成插件**。`transparent` / `backgroundMaterial` 是 `BrowserWindow` 的构造参数，在任何插件代码执行之前就已求值。所以安装程序对 `app.asar` 里的 `lib/main.js` 做一次**等长**修改：

```js
// 插在 `show,` 之后
backgroundColor:"#00000000",backgroundMaterial:"acrylic",
```

插入 N 字节，再从紧邻的 JSDoc 注释里删掉正好 N 字节，因此压缩包**总大小、header、每个条目的偏移全部不变**。替换前会逐项自检：大小不变、header 字节一致、所有条目偏移不变、只有 `lib/main.js` 内容变化、提取出来的文件仍能解析。任何一项不过就**不写入**。

### 为什么不用 `transparent: true`

Electron 44.7.0 / Windows 11 26300，用高频棋盘格背景逐像素实测：

| 窗口参数 | 桌面透出 | 真模糊 | 原生阴影 |
| --- | --- | --- | --- |
| `backgroundMaterial:"acrylic"` | 是 | **是** | **保留** |
| 再加 `transparent: true` | 是 | 是 | **坍缩到约 2px** |
| 只有 `transparent: true` | 是 | **否**（清晰，不模糊） | 约 2px |
| `backgroundMaterial:"mica"` | **否** | — | 无 |

只加 `acrylic` 就已经同时拿到真模糊和窗口阴影；再加 `transparent: true` 只是牺牲阴影，模糊并不会更好。DSH 自己的欢迎窗口用的也正是这个写法。

### 模糊为什么要单独一层

`backdrop-filter` 会让元素成为**固定定位后代的包含块**。应用里的菜单和对话框都按视口定位，把滤镜加在外框上会让所有弹层被重新锚定到那个框上；而 Windows 上那个框还带标题栏偏移，于是全都会往下移。

所以插件改成**追加一个空的固定层，`z-index:-1`**，放在所有内容之后。它没有子元素，不可能成为任何东西的包含块。

---

## 兼容性

- **DSH 0.2.x**（Electron 44）。补丁锚定 `lib/main.js` 里的 `createWindow()`；将来版本若移动了位置，工具会**明确报错而不是瞎猜**。
- **主题插件**：不受影响——叠加层的颜色取自主题注册表，只改 alpha。
- **`prefers-reduced-transparency: reduce`**：插件会自动停用，并在设置里说明，而不是无视你的系统设置。
- **菜单和弹层**刻意保持不透明，保证可读。
- **应用更新会替换 `app.asar`**，窗口补丁失效。重跑安装程序即可；插件和你的设置都还在。

---

## 已知限制

- **桌面透出仅限 Windows**。macOS 有表面透明 + 系统 vibrancy；Linux 只有表面透明。
- **侧栏**有自己的背景层，看起来会比主区域略清晰一些。那一层同时承载固定定位菜单，加模糊有定位风险，因此没有默认开启。
- acrylic 的模糊半径由 Windows 决定，应用改不了。
- 壁纸很亮时文字对比度会下降。要读长文就调高 `GLASS_TOKENS` 的百分比。

---

## 开发

```bash
npm test
```

三个测试，不需要浏览器：

| 测试 | 守着什么 |
| --- | --- |
| `glass-client-contract.test.mjs` | 加载**真实的** `client.js`，跑它的 factory，用**零 props** 渲染设置行，断言 token 叠加层和唯一的模糊层 |
| `glass-row-render.test.mjs` | 设置行的三种状态（开启／减少透明度／无语言服务） |
| `glass-render.test.mjs` | 主题叠加层的可重入保护 |

每个测试都带一条「旧写法必须失败」的反向断言，所以它们不会在没人注意时变得什么都不测。

这两个 bug 就是这些测试存在的原因，都是踩出来的：

1. 在设置行里读 `props.t`。那个槽位的 owner 声明是 `children?: never`、不传任何 props，于是每次渲染都抛异常，槽位系统把条目**永久废止**——设置页只是空着，错误只在控制台里。
2. 用 `ctx.get('theme')` 而不是声明 `inject: ['theme']`。热更新时服务已存在所以能用；冷启动时插件先激活，拿到 `undefined`，插件无声消失。

---

## 许可

[MIT](LICENSE) © dsh-glass-skin contributors

DeepSeek Harness 是独立产品；本仓库只往你自己的安装里加文件，并且对改动过的东西保留逐字节备份。
