# dsh-mimo-extension

DeepSeek Harness 插件，把小米 MiMo 的额度和用量放进对话界面：模型选择器旁的**额度环**，加一个 **MiMo 用量** 详情页。

```sh
dsh plugin --profile web add dsh-mimo-extension
```

| 额度环 | 点击弹出用量摘要 | 移动端（390px） |
| --- | --- | --- |
| ![额度环](assets/screenshot-1-ring.png) | ![用量摘要卡](assets/screenshot-2-popover.png) | ![移动端](assets/screenshot-3-mobile.png) |

## 功能

| 入口 | 显示内容 |
| --- | --- |
| 额度环 | mi logo 嵌在环里，环画**套餐剩余百分比**。按量计费没有总量，只画空环，不画误导性的 0% 或 100% |
| 点击额度环 | 用量摘要卡：计费类型、剩余额度或会话 tokens、本月已用、套餐总量、请求次数、当前模型，底部进详情页 |
| 详情页 | 当前模型、计费类型、本会话 MiMo 用量、今日与历史用量、费用估算、用量趋势与预测 |

额度环的位置可以改（标题行 / 输入框工具栏 / 输入框上方 / 不显示），详情页底部能配 Cookie。

## 安装

```sh
# npm
dsh plugin --profile web add dsh-mimo-extension

# GitHub
dsh plugin --profile web add github:upcyan/dsh-mimo-extension

# Release 里的预构建包
dsh plugin --profile web add \
  https://github.com/upcyan/dsh-mimo-extension/releases/latest/download/dsh-mimo-extension.tgz
```

装完重启 `dsh web`，刷新浏览器。确认装到了正确位置：

```sh
P="$DSH_HOME/profiles/web"
grep '"dsh-mimo-extension"' "$P/package.json"
dsh --profile web --dump-config | grep -A2 mimo-extension    # 应打印 id: mimo-extension
```

两个环境注意事项，跟插件本身无关：

- **显式设置 `DSH_HOME`**。不设时 `dsh` 回退到 `~/.dsh`。在 root shell 里跑会装进 `/root/.dsh/profiles/web`，而不是应用实际使用的 `$DSH_HOME/profiles/web`，表现为"装成功了但界面没变"。
- **可能要加 `--config.minimumReleaseAge=0`**。pnpm 11 默认做 24 小时"最小发布年龄"检查，lockfile 里有刚发布的包时 install 会在校验阶段被拦下。

profile 目录只读时，见文末的手动安装。

## 配置

### Cookie

填了 Cookie 才能读到官方额度。

| 字段 | 作用 |
| --- | --- |
| MiMo 控制台 Cookie | 官方接口鉴权。留空表示保持不变；勾「清除已保存的 Cookie」可清掉 |
| 本地兜底套餐总量 | 没配 Cookie 时，用来估算月度总量的 tokens 数 |
| 额度胶囊位置 | 见下 |
| 允许输入框工具栏自动换行 | 见下 |
| 启用 MiMo 视觉路由 | 见下 |

保存的值写进 `$DSH_HOME/settings.yaml` 的 `dsh-mimo-extension` 命名空间，优先级高于 `cordis.patch.yml` 里的 `config`（后者只作组成基线）。

### 这个 Cookie 是给套餐用的

同一个控制台 Cookie 打三个接口，**Token Plan 的数据依赖它**：

| 接口 | 读什么 | 归属 |
| --- | --- | --- |
| `tokenPlan/detail` | 套餐码、周期、是否过期 | Token Plan |
| `tokenPlan/usage` | 已用百分比、各项 items | Token Plan |
| `balance` | 现金和赠金余额 | 按量 |

套餐用户不填 Cookie，剩余百分比就读不到（两个 `tokenPlan/*` 都返回 401），只能退回本地估算。按量用户填了也只多一个 `balance`，按量本来就没有 `tokenPlan/usage`。

实测（2026-09-27，有效 Cookie）：

```sh
curl -H "cookie: <你的 Cookie>" https://platform.xiaomimimo.com/api/v1/tokenPlan/detail
# → {"code":0,"data":{"planCode":"lite:year","currentPeriodEnd":"2027-09-04 23:59:59",...}}

curl -H "cookie: <你的 Cookie>" https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
# → {"code":0,"data":{"monthUsage":{"percent":0.1186,"items":[{"name":"month_total_token",...}]}}}
```

Cookie 是几百字符的长串，输入框支持 Ctrl+V、右键粘贴，另有一个「粘贴」按钮走 `navigator.clipboard.readText()` 兜底（无权限或非安全上下文会提示手动粘贴）。输入框是 `type="text"` 而非 `password`，粘贴不受浏览器对密码字段的限制，内容也能看见便于核对。

获取步骤（表单里也有）：

1. 登录 <https://platform.xiaomimimo.com>
2. DevTools → Network → 任一 `/api/v1` 请求 → Headers → 复制完整 `Cookie` 请求头
3. 确认含 `api-platform_serviceToken` 与 `userId`，整段粘进表单保存

不用界面也行：写进 `$DSH_HOME/.credentials.yaml` 的 `refs.MIMO_CONSOLE_COOKIE`，或直接编辑 `cordis.patch.yml` 的 `mimo.cookie`。

Cookie 只存本机 `settings.yaml`，不回传给浏览器。读取接口只返回「是否已配置 + 来源」，输入框也不回显明文。

### 胶囊位置

在「MiMo 用量」页底部的表单里选，保存即生效：

| 取值 | 位置 | 说明 |
| --- | --- | --- |
| `header` | 标题行 | 与「对话 / 轨迹」同一行的右侧动作区 |
| `toolbar`（默认） | 输入框工具栏 | 模型选择器旁，即 codebuddy 用量环的位置 |
| `above` | 输入框上方 | 独占一行，最不挤占其它工具 |
| `hidden` | 不显示 | 只留详情页 |

点击环弹出的摘要卡，不管胶囊在哪个座位都用 `createPortal` 挂到 `document.body`，再按锚点位置和视口空间摆位：水平越界就左移、贴顶就翻到下方、`resize` 和滚动时重算、内容过高时内部滚动。祖先的 `overflow` 裁不到它，320px 窄屏和 800×360 横屏下都完整可见。

### 工具栏自动换行

插件多了以后，输入区的工具图标会互相挤压重叠。表单里的「允许输入框工具栏自动换行」（默认开）注入的样式只作用于**组内**（`_tools` / `_actions` / 左右槽位容器），让图标在本组内折行，不动整行。整行是否换行由产品原生样式决定；装了 `dsh-web-mobile-cyanmod` 时会被它覆盖成 `nowrap`，两者可以叠加。关掉立即恢复官方默认。

### 视觉路由

在「MiMo 用量」页底部勾选「启用 MiMo 视觉路由（图像输入）」。

平台按模型的 `inputModalities` 拦图片附件，`dsh-api-session-controller` 会抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`。这个值来自 `llm-pi-ai` 里每个模型的 `input` 字段。开启后插件把多模态模型的 `input` 写成 `["text","image"]`，图片就能发给它们。

只对平台目录声明支持图像的模型生效（数据来自 pi-ai 的 `dist/providers/data/xiaomi*.json`）：

| provider | 模型 | catalog 的 input | 本开关 |
| --- | --- | --- | --- |
| `xiaomi` / `xiaomi-token-plan-{cn,sgp,ams}` | `mimo-v2.5` | `["text","image"]` | 写入 |
| 同上 | `mimo-v2.5-pro` | `["text"]` | 不碰 |
| `xiaomi` | `mimo-v2.5-pro-ultraspeed` | `["text"]` | 不碰 |

不给纯文本模型撑腰是有意的：硬声明图像支持会把失败从"明确拒绝"变成"图片被上游静默丢弃"，而后者用户以为发出去了。自建 provider（比如 `mimo`）也不在内置表里——它的模型清单由你自己声明，能力也该由你自己声明。

写入用 `settings.mutate("llm-pi-ai", ops)` 整条替换 `models` 数组，只改目标模型的 `input`，不重写整个 provider。已经是 `["text","image"]` 就不写；关闭时去掉 `image` 并保留其它模态（空了补回 `["text"]`）。启动时会再同步一次，因为开关可能比写入活得久（插件重装、配置被改）。

写入失败会回显：`POST /settings` 回传 `visionChanged` / `visionError`，表单显示"已开启：`<模型列表>`"或失败原因，不会只报"已保存"。

这是跨命名空间写入（改的是 `llm-pi-ai`）。平台 `settings.write()` 只校验命名空间已注册，不校验调用者归属，所以可行；但只读 provider 上会失败并报错。

#### 子选项：同时为纯文本模型提供视觉能力

主开关下方还有一个「同时为纯文本模型提供视觉能力」，默认关，且主开关关时禁用。它额外给平台标为纯文本的小米模型声明图像输入：

| provider | 模型 | catalog input |
| --- | --- | --- |
| `xiaomi` | `mimo-v2.5-pro`、`mimo-v2.5-pro-ultraspeed` | `["text"]` |
| `xiaomi-token-plan-{cn,sgp,ams}` | `mimo-v2.5-pro` | `["text"]` |

这是越权声明：上游可能拒绝，也可能静默丢图（你未必收到报错，比明确报错更麻烦）。确认这些模型实际能读图时再开。

回收是精确的。两张模型清单（多模态 / 纯文本）各自决定自己去留，关掉子选项时只回收它加过的，不会删掉 catalog 本就给 `mimo-v2.5` 声明的 `image`——那归主开关管。

## 显示规则

### 只在用 MiMo 模型时显示

额度环绑在 MiMo 通道上，所以只在当前模型属于 MiMo 时渲染。读会话投影 `modelSelection` 的 `next` / `lastUsed`，与 `dsh-codebuddy` 的 `codebuddyUsageVisible` 同一机制。

判定以 **API 地址**为准，名字只作参考。平台内置 catalog 里的小米路由有两类命名：`xiaomi`（按量）和 `xiaomi-token-plan-cn` / `-sgp` / `-ams`（套餐），它们都不含 `mimo`；反过来，自建网关可以叫 `mimo-xxx` 却指向别家。所以：

- 地址是 `xiaomimimo.com` 域名 → 是
- 地址明确是别家 → 不是
- 地址读不到 → 退回名字（provider 名含 `mimo` / `xiaomi*`，或模型名含 `mimo`）

用别的 provider（比如 codebuddy）时整个环不渲染，免得"明明没用 MiMo 却在报 MiMo 额度"。这时候详情页会在模型卡下标注「当前模型属于 X，不是 MiMo，下面的套餐额度是 MiMo 账号级的」。读不到 provider 时保持显示，宁多显示也不因读取失败静默关掉功能。

详情页可以设成「非 MiMo 时隐藏」：开启后不是 MiMo 就把整个 tab 收掉，切回 MiMo 自动恢复。默认关闭（一直显示）。

### 会话用量按渠道归属

一个会话可以换过模型，所以 `session.totalTokens` 不等于 MiMo 用量。实测某会话：

```
mimo/mimo-v2.6-flash          49,771,661 tokens / 367 calls
codebuddy/deepseek-v4.1-flash 89,081,411 tokens / 414 calls
─────────────────────────────────────────────────────────
总计                         138,853,072 tokens（其中 64% 不是 MiMo）
```

插件按 `models[].provider` 只统计 MiMo 归属的部分，三种情形都有交代：

| 情形 | 显示 |
| --- | --- |
| 会话混用了多个渠道 | 汇总只算 MiMo；下方列出各非 MiMo 渠道并声明「不计入上方汇总」；费用标注「估算」（分渠道明细只有总量、没有输入输出拆分，按 token 占比折算） |
| 本会话完全没用 MiMo | 提示「本会话尚未使用 MiMo，会话用量为 0 是正常的」，并说明下方套餐额度是账号级的、与会话无关 |
| 无分渠道明细（老计数器或统计降级） | 标注「未细分渠道」，退回整体计数。不猜测，也不把数据抹成 0 |

明细表给非 MiMo 行加「不计入 MiMo」标记并弱化，另加 `%` 列显示各渠道占比。

早期版本用整会话的 input/output 乘 MiMo 单价算费用，会话换过模型时会把别的渠道的消耗也算进来，费用因此偏高。

### 尺寸与外观

额度环对齐 `dsh-codebuddy` 的用量环，两者并排时大小一致：

| 项 | 值 | 对应 codebuddy |
| --- | --- | --- |
| 环直径 | `26` | `Progress type="circle" width={26}` |
| 环宽 | `3` | `strokeWidth={3}` |
| 中心 logo | `12` | `CodeBuddyLogo size={12}` |
| 环底圈 | `--dsw-alias-border-l3` | `orbitStroke` |
| 环进度 | `--dsw-alias-label-tertiary` | `stroke` |
| logo 底色 | `#ff6900`（小米品牌橙） | `variant="brand"` 的写死色 |
| 起点 | `rotate(-90)`，12 点方向顺时针 | Semi 默认 |

尺寸不随窄屏或紧凑模式缩小，紧凑场景靠去掉内边距解决。配色用平台主题变量（`dsh-web-frontend` 定义），自动跟随主题。

logo 用固定品牌色而不是主题变量 `--dsw-alias-brand-primary`，因为本机主题把那变量定义成 `#0f1115`（近黑），环心会变成一团看不清的黑块。品牌 mark 保持品牌色，codebuddy 也这么干（它的 `CodeBuddyLogo` 在默认变体下写死 `#6C4DFF`，只有 `mono` 变体才用主题变量）。

codebuddy 用 `@douyinfe/semi-ui` 的 `Progress`，而 semi 不在平台 seed 表里（它自己打进了 6.5MB bundle）。本插件手写等价的 SVG 双圈，零依赖。mi logo 用 [simple-icons 的 xiaomi 路径](https://github.com/simple-icons/simple-icons/blob/develop/icons/xiaomi.svg)。

### 移动端竖屏

窄屏（<640px）自动切布局：

- 详情页各卡片区从多列改单列堆叠，内边距与字号收窄
- 按模型的表格外层可横向滚动，不撑破卡片
- 用量柱状图降低柱高（60px → 46px）并允许横滚
- 胶囊在窄屏隐藏文字，只留百分比或用量数值，避免挤压会话标题

宽屏（≥640px）保持多列自适应。横竖屏切换和窗口拖动都会实时重排。

## 数据与计费

### 数据来源

**官方接口优先**（需 Cookie）：

- `GET https://platform.xiaomimimo.com/api/v1/balance` — 余额 / 现金 / 赠金
- `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail` — planCode、currentPeriodEnd、expired
- `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` — monthUsage{percent, items[{name, used, limit, percent}]}，percent 需 ×100
- 鉴权：请求头带 `Cookie`（含 `api-platform_serviceToken` 与 `userId`）

**本地估算兜底**（Cookie 没配或接口失败）：

- 聚合 `$DSH_HOME/token-usage/usage-*.jsonl` 的本月用量
- 除以 `mimo.planTotalTokens`（默认 5 亿/月）得剩余百分比
- 详情页顶部标注「本地估算（官方接口不可用）」

**内置会话统计**（`token-usage/` 目录不存在时）：

- `token-usage/` 和 `ctx.tokenUsageCounter` 都由 `dsh-token-usage-counter` 提供。该插件没装进 profile 时目录根本不存在，旧行为是把 `ENOENT ... scandir '.../token-usage'` 当错误抛出来，而且「今日/本月 tokens」「当前会话用量」永远是 0。
- 现在目录缺失按「暂无记录」处理（`local.ok=true, local.missing=true, local.note` 说明原因），并由 `createLocalUsageCounter()` 直接读会话事件（`assistant/message.data.usage`）自建统计填上数值，来源标 `local.source = "session-events"`。
- 口径是**进程启动以来仍存活的会话**，重启归零。它只读不落盘；一旦 `dsh-token-usage-counter` 装回来并有数据，仍以它的落盘数据为准。
- 去重靠事件 `seq`，`/session` 每 60 秒重复扫描不会把用量翻倍。

### 计费类型判定

顺序如下（`billingTypeFor()`）：

1. `mimo.billingTypeOverrides`（`provider/model` 或 `provider`）—— 用户说了算
2. **provider 的 API 地址**（从 `llm-pi-ai` 命名空间读）。小米两条通道的地址不同（pi-ai 官方目录 `providers/*.json` 实测）：

   | 计费方式 | 目录里的 provider | baseURL |
   | --- | --- | --- |
   | 按量付费 | `xiaomi` | `https://api.xiaomimimo.com/v1` |
   | Token Plan | `xiaomi-token-plan-cn` | `https://token-plan-cn.xiaomimimo.com/v1` |
   | Token Plan | `xiaomi-token-plan-sgp` | `https://token-plan-sgp.xiaomimimo.com/v1` |
   | Token Plan | `xiaomi-token-plan-ams` | `https://token-plan-ams.xiaomimimo.com/v1` |

   地址含 `token-plan` → 套餐；是 `xiaomimimo.com` 其余子域 → 按量；读不到（自建网关、命名空间缺失）→ 继续往下。
3. provider 名含 `token-plan` → 套餐
4. provider 是小米通道但地址没读到 → 用官方 `tokenPlan/detail` 反证（`summary.planStatus` 四态）：`expired`（已过期）或 `none`（官方明确无订阅）→ 按量；`active` / `unknown`（没配 Cookie、接口失败）→ 套餐
5. 其余 provider → 按量

想强制某条路由按量（或反过来），写 `billingTypeOverrides: { mimo: payg }`。

单价按量模型用 `mimo.pricing.<provider/model>`（元/百万 tokens），没配则用 `fallbackPrice`。Token Plan 套餐内调用不额外收费。

### 「当前模型」从哪读

判定用的 `provider` / `model` 是**当前选中的**，不是最近一次请求用过的：

| 优先级 | 来源 | 语义 |
| --- | --- | --- |
| 1 | `agent-default-model` 命名空间 | 用户此刻选的是什么（切模型立即写入，与 UI 同源） |
| 2 | `session/event` 的 `request/header` | 最近一次真的发过请求用的是什么 |
| 3 | 落盘计数器快照 | 历史 |
| 4 | 内置统计快照 | 历史 |
| 5 | 空 | 计费退化为 provider 命名约定 |

第 1 级必须在第 2 级之前。早期只有 2~4 级，于是在 UI 里把模型切到 MiMo 但还没发消息时，仍按旧模型判定，显示"按量付费"而模型选择器已经是 MiMo。这个顺序是有语义的。

### 数量单位

小米 Token Plan 的额度单位是 **Credits**，不是 tokens，也不是人民币；按量付费才是人民币余额，两者不通用：

- 订阅套餐时 `/api/v1/balance` 恒为 0，这是正常的，详情页会标注说明
- 官方换算（每百万 token 消耗的 Credits）：

  | 模型 | 缓存命中 | 缓存未命中 | 输出 |
  | --- | --- | --- | --- |
  | mimo-v2.6-pro | 2.5 | 300 | 600 |
  | `mimo-v2.6-flash` | 2 | 100 | 200 |
  | mimo-v2.5-pro | 2.5 | 300 | 600 |
  | mimo-v2.5 | 2 | 100 | 200 |

- 闲时 0.8 倍：北京时间 00:00–08:00 只扣 80%
- 用量到 50% / 90% / 100% 时官方发短信和邮件

`tokenPlan/usage` 返回的 `percent` 是 **0~1 的比值**，要 ×100 才是百分比。实测 `used/limit = 4725102737/49200000000 = 0.096038`，接口回 `percent: 0.0960`；控制台前端的换算是 `Math.min(100, Math.max(0, 100 * e))`，所以官网显示 9.6%。本插件 `toPercent()` 用同一口径。早期版本直接当百分数显示，「本月已用」只有真实值的 1/100。

## 排查「装了没生效」

浏览器里看不到胶囊或详情页这类问题，服务端看不见。所以浏览器半边每走一个节点就往宿主 `POST /dsh-mimo-extension/ping` 报一次，从 `/summary` 的 `client` 字段读结果：

```sh
# <dsh 地址> 换成你的 dsh web 地址（默认 http://127.0.0.1:<port>）
curl -s "<dsh 地址>/dsh-mimo-extension/summary" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['client'])"
```

| `client.stage` | 含义与下一步 |
| --- | --- |
| `null` | 浏览器没跑到新代码：硬刷新（Ctrl+Shift+R）。host.js 刚改过就先重启 `dsh web`（`/ping` 是 host 侧路由） |
| `module-loaded` | 脚本执行了但工厂没被调，fiber 没激活。去「设置 → 插件」看该行状态（`failed` / `pending (waiting for services: …)`） |
| `factory` | 工厂调了但 `apply` 没跑，fiber 还在 pending 或 apply 抛错，看浏览器控制台 |
| `apply-entered` | apply 开跑但没到 `applied`，中途抛错，控制台搜 `[dsh-mimo-extension]` |
| `applied` | 前端注册完成（`registered` 列出注册的槽位、`pillPosition` 是当前胶囊位置）。仍看不到就是渲染层或槽位层的问题 |
| `skipped` / `skipped-duplicate` | 被包名守卫或重复装载兜底主动收手，`entryName` 会一并回传 |

同一 origin 下往往有多个标签页（工具页、对话页）各自报到，最近 20 条时序和页面路径在 `clientLog` 里（每条带 `path`、`hash`、`at`）：

```sh
curl -s "<dsh 地址>/dsh-mimo-extension/summary" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['clientLog'])"
```

`path` 和 `clientLog` 是 host 侧字段，host.js 更新后要重启 `dsh web` 才有；旧 host 会直接丢掉多出来的字段，不报错。

`apply()` 里曾有一条严格相等的包名守卫（`entryName !== "dsh-mimo-extension" → return`）。宿主一旦用别名装载，整颗插件会静默消失（胶囊和详情页一起没，且没有日志）。现在只在名字明确属于别的插件时才跳过，并打 `console.warn` 加 `probe("skipped")`；重复装载靠 `slots.entriesOfSlot` 兜底。

## 从 dsh-mimo-usage 升级

插件原名 `dsh-mimo-usage`，2026-09-27 改名为 `dsh-mimo-extension`，仓库和 npm 包名同步改了。

配置不用手工搬。启动时会自动把旧命名空间 `dsh-mimo-usage` 里的用户配置（含 Cookie、套餐总量、胶囊位置、各开关）迁移到 `dsh-mimo-extension` 段。迁移单向、幂等（新段已有配置就不覆盖），且**不删除旧段**，留作回滚依据，确认无误后可自行清理。

迁移只搬 `mimo` 子对象。旧段里手工加过其它字段的话需要自己处理。

profile 里的旧依赖（`file:dsh-mimo-usage-*.tgz`）不会自动消失，需要先 `dsh plugin remove dsh-mimo-usage` 再装新的。

## 附：fnOS 网关部署

只用 fnOS NAS 的读者需要看这一节，其它环境可以跳过（`3081`、`3080` 是 fnOS 应用分配的端口，不是 dsh 默认值）。

插件宿主路由是 `/dsh-mimo-extension/*`，刻意不用 `/api/*`。DSH 核心对 `/api` 有一条 Host/Origin fence（`dsh-client-connection` 的 `isTrustedApiRequest`）：`Host` 必须是 loopback 或在 `--trusted-host` 里，**且 `Origin.host` 必须完全等于 `Host`**。经 fnOS 网关（`https://<NAS>:3080`）访问时 `Host` 被改写成 `127.0.0.1:3081`，而浏览器发的 `Origin` 是 `https://<NAS>:3080`，第二条永不成立，一律 403。非 `/api` 前缀没有这层 fence。

fnOS 网关把页面挂在 `/app/dsh-fnos/dsh/` 下，转发前剥掉前缀、改写 `<base href>`、并在 `<head>` 注入 `globalThis.__FNOS_GATEWAY_PREFIX__ = "/app/dsh-fnos/dsh"`。

**`<base href>` 对以 `/` 开头的绝对路径无效。** 所以插件直接 `fetch("/dsh-mimo-extension/summary")` 会打到无前缀路径，落到 core 的未注册路径上：POST 拿到 `dsh-host-frontend-static` fallback 的 405 空 body，GET 拿到 404。

平台只给官方客户端模块（`dsh-client-connection` / `dsh-api-gateway` / `dsh-client-hmr` / `dsh-client-file-upload` / `dsh-client-ui-deliverables` / `dsh-session-log-export`）用 `patch-dsh.mjs` 打前缀补丁，第三方插件必须自己处理。本插件的 `gatewayPath()`：

```js
function gatewayPath(path) {
  let prefix = "";
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.__FNOS_GATEWAY_PREFIX__ === "string") {
      prefix = globalThis.__FNOS_GATEWAY_PREFIX__;
    }
  } catch { /* 忽略 */ }
  return prefix.replace(/\/+$/, "") + path;   // 去尾斜杠，避免 //
}
```

每次发送时求值，不是模块加载时——前缀由 HTML 内联脚本注入，而本脚本同为启动清单成员，执行顺序不保证。

| 环境 | `__FNOS_GATEWAY_PREFIX__` | 实际请求路径 |
| --- | --- | --- |
| 直连 `http://127.0.0.1:3081` | `undefined` | `/dsh-mimo-extension/summary` |
| 经网关 `https://<NAS>:3080` | `/app/dsh-fnos/dsh` | `/app/dsh-fnos/dsh/dsh-mimo-extension/summary` |

写插件时，任何自己的 HTTP 路由都套一层 `gatewayPath()`，否则只在直连时能用、经网关必挂。诊断通道尤其要注意：它正是用来排查"装了没生效"的，自己先被网关挡掉就白搭。

### 端点一览

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/dsh-mimo-extension/summary` | GET | 额度与用量汇总（`?refresh=1` 绕过缓存） |
| `/dsh-mimo-extension/session` | GET | 指定会话的 token 用量（`?id=<sessionId>`） |
| `/dsh-mimo-extension/settings` | GET / POST | 读取 / 保存配置 |
| `/dsh-mimo-extension/ping` | POST | 浏览器半自诊断回传，随 `/summary` 的 `client` 字段吐出 |

## 开发

### 结构

- `host.js` — 宿主插件。注册 `/dsh-mimo-extension/*` 路由、读写设置、聚合统计；调官方接口，失败回退本地日志聚合。另注册 `/mimo` 斜杠命令和 `mimo_usage` 工具供模型查询。
- `client.js` — 浏览器 bundle，走 `__ModuleLoader__` 工厂格式，只依赖平台共享的 react，无构建步骤。注册 `conversation.input.right`（或按配置换座位）的额度环，以及 `conversation.view` 槽位的详情页 tab。
- `package.json` — 声明 `dsh.bundle` 与 `dsh.client`。
- `cordis.patch.yml` — 自激活层，含默认配置与 Cookie 说明。

### 更新频率

- 胶囊挂载、切换会话、点击、页面从后台切回 → 立即刷新
- 每 60 秒静默刷新一次
- 空闲时没有其它轮询

### 手动安装（profile 目录只读时）

```sh
# 1. 把包放进 profile
cp -r dsh-mimo-extension "$DSH_HOME/profiles/web/node_modules/dsh-mimo-extension"

# 2. profile package.json 的 dependencies 加一行：
#    "dsh-mimo-extension": "file:./node_modules/dsh-mimo-extension"

# 3. "dsh.profile.bundles" 末尾加 "dsh-mimo-extension"
```

本插件的 `cordis.patch.yml` 自带 `- insert` 行，装进 `node_modules` 并加入 `bundles` 后，`patchReload: live` 会在下次启动自动应用，不用手改 profile 的 `cordis.patch.yml`。

### 测试

```sh
node check.mjs          # 209 项：静态检查 + 单元回归
node check-client.mjs   # 187 项：mock ctx 离线跑 apply
node verify-fix.mjs     # 端到端，需真 Cookie
```

两个 `check` 脚本是纯 Node，不装任何依赖也能跑。CI 里没有 dsh，`check.mjs` 会把一项需要 schemastery 的检查标为跳过，不算失败。

### 维护提示

- 改 `client.js`：刷新页面即生效
- 改 `host.js`：**热重载不生效**（Node ESM 缓存），必须重启 `dsh web`。`patchReload: live` 只管 patch 层，不动已加载模块的代码。

### 计费口径

- Token Plan 套餐：套餐内调用不额外扣费，只消耗套餐 token 配额；胶囊和详情页显示剩余百分比
- 按量计费：按 provider/model 单价估算（元/百万 tokens），缓存命中按 `cacheRead` 单价
- 估算值仅供参考，实际扣费以小米 MiMo 官方账单为准
