# Prisir 视觉标识统一提案

> 状态:调研 + 提案(只读,未改任何功能代码)
> 作者:Prisir 视觉标识专属 agent
> 日期:2026-08-12
> 范围:统一 Prisir 浏览器(SecBrowser 重编译)与其下 custom-hover-translate 翻译插件系列的视觉标识

---

## 0. 设计语言坐标(三条线索)

整个产品族的视觉语言由三条独立演化的线索叠加而成,统一前先对齐坐标:

| 线索 | 来源 | 主色 | 意象 |
|---|---|---|---|
| **国画浅色主题(guohua)** | `assets/guohua-theme.css`、`guohua_bg_*.png`,已被 oiagent_web / SecureDM 复用 | 宣纸 `#f6f1e7` 底、浓墨 `#2f3a34`、水墨灰绿 `#6c7c72/#4a5c52`、暖金 `#d6b26c`、印章赭红 `#b23a30` | 采薇/蒹葭,水墨山水,**浅色** |
| **babelspan 内容站(dark ink)** | https://www.babelspan.com/ 与 /models.html(见 `_models_preview.png`) | 深墨蓝黑底、铜/橙 accent、teal accent | 通天尺规、航海/海图/水深/航道,**深色** |
| **插件当前 UI(通用蓝)** | `extension/src/popup.css`、`options.css`、`inject.css` | `#4a8eff` 亮蓝 + 浅灰底 | 无特定意象,默认工具蓝 |

任务书关键词 **dark ink / copper / teal + 通天尺规/航海** 与第二条线索(babelspan)完全同源。guohua 是浅色姊妹主题(已被兄弟产品占用),插件的 `#4a8eff` 蓝则是无归属的第三套,是本次统一的主要收敛对象。

---

## 1. 现状盘点表

| 触点 | 文件 / 位置 | 当前标识 | 当前用色 | 备注 |
|---|---|---|---|---|
| **浏览器图标(大)** | `assets/secbrowser_icon_256.png` | 圆形浅色国画徽标:纸底 + 青绿弧 + 暖金日 + 印章红方块 | 宣纸底、青绿、暖金、印章红 | 偏 guohua 浅色,**与 dark ink 方向相反** |
| **浏览器图标(128/48/32/16)** | `assets/secbrowser_icon_{128,48,32,16}.png`、`secbrowser.ico` | 同上多尺寸 | 同上 | 16/32 小尺寸下红色方块糊成一团,辨识度差 |
| **浏览器主题 CSS** | `assets/guohua-theme.css` | —(纯 token,无图) | 浅色宣纸/墨绿/暖金/印章红 | 被 oiagent_web、SecureDM 复用,**不宜改** |
| **浏览器背景图** | `assets/guohua_bg_panel.png`、`guohua_bg_wide.png` | 水墨山水淡影 | 宣纸 + 极淡灰绿远山 | 浅色,仅供 `.gh-backdrop` 选用 |
| **插件图标(action/icon)** | `extension/icons/{16,32,48,128}.png` | 蓝色圆角方块 + 白「译」字 | `#4a8eff` 蓝底白字 | manifest.json `icons.*` 与 `action.default_icon` 引用 |
| **插件 popup 配色** | `extension/src/popup.css` | — | 主按钮/链接/active chip `#4a8eff`,alt 按钮 `#2bb673` 绿,背景 `#fafbfc` 浅灰 | 约 20 处 `#4a8eff` |
| **插件 options 配色** | `extension/src/options.css` | — | 边框/按钮 `#4a8eff`,背景 `#fafbfc` | 与 popup 同源 |
| **插件注入译文边线** | `extension/src/inject.css` | — | 译文左边线 + pending 微光 `#4a8eff`,error `#e44` | 设计原则:文字色 inherit,仅边线/淡背景着色,亮暗页自适应 |
| **babelspan 站标** | 站 `assets/rubriclab-mark-primary.png`(本地无副本) | 「通天尺规 · Babelspan」字标 + 尺规图形 | 深墨底 + 铜/橙 + teal | 同源意象,**但图形资产不在本仓库**,仅站端持有 |

**一句话总结现状:** 浏览器图标是「浅色国画」,内容站是「深色航海尺规」,插件是「无归属蓝」——三套语言互不相认,且唯一承载「通天尺规」正意象的图形(站标)不在可控资产里。

---

## 2. 方案 A:沿用 babelspan 站标

把站端 `rubriclab-mark-primary.png` 拿过来,同时用作浏览器图标与插件图标(缩多尺寸)。

**利**
- 单一资产,立刻对齐内容站,用户从站 → 浏览器 → 插件的认知链路最短。
- 零新设计成本,方向已被任务书认可(dark ink/copper/teal + 尺规)。

**弊**
- **资产不可控**:源文件在站端仓库,本地只有渲染截图,没有矢量/高清源,16/32 小尺寸需重绘而非缩放。
- **语义错位**:尺规是「评测/海图(Babelspan=榜单/选型)」的隐喻,套在「浏览器(Prisir)」和「翻译功能(译)」上,讲的是"度量"而非"浏览/转换",层级关系反了(子品牌意象盖住母品牌)。
- **深色站标直接压进浏览器工具栏/任务栏**,在浅色 OS 主题下对比差;站标为横排字标,裁成方形 app 图标需重新排版。
- 16px 下尺规细线必然糊掉,需要单独画 favicon 级简化版——等于还是要做一套适配,省不了多少。

**结论:** 适合「借用配色 + 意象」,不适合「直接搬图」。

---

## 3. 方案 B:新设计统一图标(推荐方向)

不重绘具体内容,只定义**设计系统 + 层级规则**,让浏览器与插件共享一套可生成的标识。

### 3.1 调色板(锁定 dark ink / copper / teal)

```
--prisir-ink:      #0f1a24   /* 深墨蓝黑底(主底) */
--prisir-ink-2:    #1b2b3a   /* 次底/卡片 */
--prisir-copper:   #c98a4b   /* 铜(主 accent,呼应 babelspan 橙) */
--prisir-copper-2: #e0a866   /* 亮铜(hover/高光) */
--prisir-teal:     #2f8f83   /* teal(次 accent,呼应 babelspan teal) */
--prisir-teal-2:   #4fb3a4   /* 亮 teal */
--prisir-paper:    #f2ede2   /* 文字/前景浅色 */
```
> 注:babelspan 截图的精确 hex 未在 CSS 暴露(站端未返回),上面是按 `_models_preview.png` 取色的近似值;落地时应对照站端样式表校正。

### 3.2 图标设计方向(描述,非成图)

**母标(Prisir 浏览器)= 通天尺规 + 罗盘/星盘**
- 圆底深墨(`--prisir-ink`),中央一枚**铜色圆规/两脚规**张开,规脚落在一条 teal 弧(海平线/航道)上,规顶一颗铜点(北极星)。
- 圆规 = 尺规(度量/通天),圆规张角 + 星 = 导航(浏览/远航),一枚图形同时说「尺规」与「航海」。
- 16/32px 简化版:只留铜色张角 + 一点星,去掉弧线,保证小尺寸辨识。
- 取代现有「浅色国画圆形」的 `secbrowser_icon_*`,与深色主题统一。

**子标(翻译插件)= 母标语言下的「译」字符**
- 保留现有「圆角方块 + 译字」的**功能识别**(用户已认得这是翻译),但换皮:
  - 底:`--prisir-ink` 深墨圆角方块(取代 `#4a8eff` 蓝)。
  - 字:`--prisir-paper` 浅色「译」。
  - 点睛:译字右上角一撇或右下角用 `--prisir-copper` 铜色收笔,或在方块右上叠一枚极小的铜色规角,作为「Prisir 出品」的母标背书。
- 这样浏览器与插件「同底不同图」:一眼同族,功能不混。

### 3.3 与 guohua 浅色的关系
- guohua 是**应用内浅色阅读主题**(已被 SecureDM/oiagent_web 占用),**不动**。
- Prisir 品牌标识走 **dark ink**,两者是「深色品牌外壳 / 浅色内容内衬」的分工,不冲突。落地时给 `.gh-backdrop` 类场景保留浅色,品牌图标/工具栏用深色。

---

## 4. 品牌层级建议

```
Prisir                    ← 浏览器品牌(母)  = SecBrowser 重编译产物
 └─ Prisir 翻译           ← 插件系列(子)   = custom-hover-translate
      └─ Babelspan        ← 内容/选型站(子子) = 模型对比,引流入口
```

| 层级 | 名字怎么用 | 图标怎么用 |
|---|---|---|
| **Prisir(浏览器)** | 独立词,作产品名 | 母标(圆规 + 星) |
| **Prisir 翻译(插件)** | 永远带前缀「Prisir 」,manifest `name` 已是「Prisir 翻译」✓ | 子标(译字 + 母标配色 + 铜点睛),不单独用母标 |
| **Babelspan(站)** | 独立内容品牌,作「Prisir 生态的内容站」 | 保留现有尺规字标,作为生态伙伴标,**不**上浏览器/插件 |

**命名规则:** 插件一律 `Prisir <功能>`(Prisir 翻译 / 未来 Prisir 字幕…),图标一律「深墨底 + 铜/teal 点睛 + 功能字/图形」,母标只在浏览器层独占。Babelspan 保持独立,避免「评测站的品牌盖住工具」。

---

## 5. 推荐方案 + 理由 + 落地步骤

### 推荐:**方案 B(新设计统一图标)**,配色与意象**借自方案 A(babelspan)**。

**理由**
1. 方案 A 的图形资产不可控且语义错位(子品牌意象压母品牌),不能直接搬;但它的 dark ink/copper/teal + 尺规/航海正是任务书要的方向,应当**继承其灵魂、重绘其形**。
2. 方案 B 用「同底不同图」建立清晰层级:浏览器=圆规母标,插件=译字符标,用户一眼分功能又一眼认同族。
3. 现有插件的 `#4a8eff` 蓝无归属,是统一的最大障碍,方案 B 一并收敛进 copper/teal 体系。
4. guohua 浅色主题不受影响(它服务兄弟产品的内容内衬),改的只是品牌外壳层。

### 落地步骤(分浏览器层 / 插件层 / 文档层)

**浏览器层(SecBrowser 重编译图标替换点)**
- 替换 `assets/secbrowser_icon_{16,32,48,128,256}.png` 与 `assets/secbrowser.ico` 为新母标(圆规 + 星)多尺寸。
- **重编译在哪一层替换:** 这些 PNG/ICO 是 Chromium 重编译时的 app 图标资源,需在浏览器源码树的 `chrome/app/theme/chromium/`(或对应 brand 资源目录,`BRANDING` 配置指定的 product logo / `product_logo_{16,32,48,256}.png` 与 `chrome.ico`)层替换后重新编译。本仓库 `assets/` 只是源图仓库,真正生效发生在重编译把图标打进 `chrome.exe` / `chrome.dll` 资源段时。
- 16/32px 用「简化版(铜张角 + 星)」,勿直接缩放 256。

**插件层(本仓库,以下仅为落地清单,本次不改)**
- 重绘 `extension/icons/{16,32,48,128}.png` 为子标(深墨底 + 浅「译」+ 铜点睛);manifest.json 引用路径不变,只换图。
- `extension/src/popup.css`、`options.css`:把 `#4a8eff` 主色、 `#3a7eef` hover、 `#2bb673` alt 收敛为 copper/teal 体系(如主 `#2f8f83` teal、强调 `#c98a4b` copper),浅灰底 `#fafbfc` 可保留或微调向 paper。
- `extension/src/inject.css`:译文左边线 `#4a8eff` → teal(`#2f8f83`/`#4fb3a4`),error `#e44` 保留。注意 inject 的设计原则是「文字 inherit、仅边线着色、亮暗页自适应」,改色时保持 color-mix 透明度逻辑不变。
- 这三处 CSS 不在本次任务改动范围,属后续功能分支工作。

**文档/资产层**
- 在 `assets/` 增加 `prisir-mark-*.png`(母标多尺寸)与调色板 `prisir-brand.css`(上面的 `:root` token),作为单一事实源。
- 站端 `rubriclab-mark-primary.png` 保留不动,作为 Babelspan 独立品牌。

---

## 附:本次只读调研所依据的文件

- `C:\Users\Administrator\oi_enhancements\assets\` : guohua-theme.css / guohua_bg_panel.png / guohua_bg_wide.png / secbrowser.ico / secbrowser_icon_16/32/48/128/256.png
- `C:\Users\Administrator\oi_enhancements\custom-hover-translate\extension\` : manifest.json / icons/*.png / src/popup.css / src/options.css / src/inject.css
- `C:\Users\Administrator\oi_enhancements\custom-hover-translate\README.md`(命名「Prisir 翻译」、babelspan 引流)
- `C:\Users\Administrator\oi_enhancements\_models_preview.png`(babelspan 站深色配色实拍)
- https://www.babelspan.com/ 与 /models.html(站标 `assets/rubriclab-mark-primary.png`、「通天尺规 · Babelspan · Reed」、航海/海图/航道文案)
