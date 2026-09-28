#!/usr/bin/env node
// dsh-mimo-extension：浏览器半边（client.js）的离线自检。
//
// 为什么需要它：client 代码只在真浏览器里由宿主调用，改坏了不容易发现
// （症状就是"装了没生效"——胶囊和详情页一起消失）。这里用最小 mock 把
// `window.__ModuleLoader__` 与宿主 ctx 复现出来，离线跑 apply：
//   1. 工厂/导出形态是否符合宿主要求；
//   2. 注入声明是否覆盖代码里真正读到的 ctx 服务（client 侧未声明**直接抛错**）；
//   3. apply 是否抛错、有没有被包名守卫静默拦掉（历史 bug）；
//   4. 「MiMo 用量」详情 tab 与胶囊槽位是否真的注册上；
//   5. 自诊断探针（/ping 的 stage）是否按预期推进。
//
// 运行：cd dsh-mimo-extension && node check-client.mjs

import { readFileSync } from "node:fs";

const pass = [];
const fail = [];
const ok = (cond, label) => (cond ? pass.push(label) : fail.push(label));

// ---------- 1) 装载 client.js ----------
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      loaded = def;
    },
  },
};
try {
  // 纯脚本：顶层只有 makeFactory、__ModuleLoader__.load 与 probe 调用
  new Function("window", readFileSync(new URL("./client.js", import.meta.url), "utf8"))(globalThis.window);
} catch (error) {
  console.error("✗ client.js 执行即抛错：", error);
  process.exit(1);
}

ok(loaded?.id === "dsh-mimo-extension", `模块 id = ${loaded?.id}`);

// ---------- 2) 工厂与导出形态 ----------
const react = {
  createElement: (...args) => ({ $$el: args }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => (typeof fn === "function" ? fn() : fn),
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  Fragment: "Fragment",
};
// react-dom 桩：只用到 createPortal（弹层挂到 body，避免被祖先 overflow 裁掉）
const reactDom = {
  createPortal: (node, container) => ({ $$portal: node, $$container: container }),
};
let plugin;
try {
  plugin = loaded.factory((id) => {
    if (id === "react") return react;
    if (id === "react-dom") return reactDom;
    throw new Error(`client.js require 了未知模块 "${id}"`);
  });
} catch (error) {
  fail.push(`factory 抛错：${error.message}`);
}
ok(plugin && typeof plugin.apply === "function", "factory 返回 { inject, apply }");
ok(Array.isArray(plugin?.inject) && plugin.inject.includes("slots"), `inject 含 slots（实为 ${JSON.stringify(plugin?.inject)}）`);
ok(Array.isArray(plugin?.inject) && plugin.inject.includes("locale"), "inject 含 locale（apply 会读 ctx.locale）");

// ---------- 3) 宿主 ctx mock：未声明服务读取即抛错 ----------
/**
 * 复现 client 侧 Cordis 的 Proxy 语义：`service "x" is not declared by your
 * plugin. Declare it on the plugin you return: { inject: [...] }`。
 * `fiber`/`effect`/`logger` 是 ctx 内建，不算服务。
 */
const BASE = new Set(["fiber", "effect", "logger", "on", "once", "get", "configure", "env", "scope", "state"]);

function makeCtx({ entryOptions, existingViewEntries, noEntriesOfSlot } = {}) {
  const declared = new Set(plugin?.inject ?? []);
  const registrations = [];
  const target = {
    fiber: { name: "dsh-mimo-extension", entry: { options: entryOptions } },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    locale: { t: (k) => k, onChange: () => () => {}, get: () => "zh-CN" },
    slots: {
      inject: (slot, cb) => {
        registrations.push({ kind: "inject", slot });
        if (typeof cb === "function") cb();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({
          kind: "register",
          slot: options?.name,
          id: options?.id,
          order: options?.order,
          hasComponent: typeof component === "function" || typeof component === "object",
        });
        return () => {};
      },
    },
    effect: (fn) => {
      const out = typeof fn === "function" ? fn() : undefined;
      return typeof out === "function" ? out : () => {};
    },
  };
  if (!noEntriesOfSlot) target.slots.entriesOfSlot = () => existingViewEntries ?? [];
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol") return t[prop];
      if (prop in t) return t[prop];
      if (declared.has(prop)) return t[prop];
      if (BASE.has(prop)) return t[prop];
      throw new Error(
        `service "${String(prop)}" is not declared by your plugin. Declare it on the plugin you return: { inject: ['${String(prop)}'], apply(ctx) {} }`,
      );
    },
  });
  return { ctx: proxy, registrations };
}

function run(scene) {
  const { ctx, registrations } = makeCtx(scene);
  let thrown = null;
  try {
    plugin?.apply(ctx);
  } catch (error) {
    thrown = error;
  }
  const viewTab = registrations.some((r) => r.kind === "register" && r.slot === "conversation.view" && r.id === "mimo-extension");
  const pill = registrations.some((r) => r.kind === "inject" && /^conversation\.(session\.header\.actions|input\.right|composer\.dock)$/.test(r.slot));
  return { thrown, viewTab, pill, registrations };
}

// ---------- 4) 各种 entry 名下 apply 都要真正注册上 ----------
const SCENARIOS = [
  { label: "entry.options.name = dsh-mimo-extension", entryOptions: { name: "dsh-mimo-extension" }, expect: "register" },
  { label: "entry.options.name 缺失", entryOptions: {}, expect: "register" },
  { label: "entry.options 为 undefined", entryOptions: undefined, expect: "register" },
  // 历史 bug：严格相等判断会在这里静默 return，胶囊+详情页一起消失
  { label: "别名 dsh-mimo-extension/client（历史 bug 场景）", entryOptions: { name: "dsh-mimo-extension/client" }, expect: "register" },
  { label: "带路径后缀 dsh-mimo-extension/client.js", entryOptions: { name: "dsh-mimo-extension/client.js" }, expect: "register" },
  // 明确是别的插件 → 应该跳过（避免串台）
  { label: "别的插件 dshmarket", entryOptions: { name: "dshmarket" }, expect: "skip" },
];

for (const scene of SCENARIOS) {
  const { thrown, viewTab, pill } = run({ entryOptions: scene.entryOptions });
  ok(!thrown, `${scene.label} → apply 不抛错${thrown ? `（实为 ${thrown.message}）` : ""}`);
  if (scene.expect === "register") {
    ok(viewTab, `${scene.label} → 注册「MiMo 用量」详情 tab${viewTab ? "" : "（缺失！）"}`);
    ok(pill, `${scene.label} → 注册胶囊槽位${pill ? "" : "（缺失！）"}`);
  } else {
    ok(!viewTab && !pill, `${scene.label} → 跳过（不串台到别人的插件）`);
  }
}

// 重复装载兜底：槽位里已有本插件 tab → 收手
{
  const { viewTab } = run({
    entryOptions: { name: "dsh-mimo-extension" },
    existingViewEntries: [{ options: { id: "mimo-extension" } }],
  });
  ok(!viewTab, "槽位里已有 mimo-extension tab → 跳过重复装载");
}
// 没有 entriesOfSlot 的老版本：不能因此抛错
{
  const { thrown, viewTab } = run({ entryOptions: { name: "dsh-mimo-extension" }, noEntriesOfSlot: true });
  ok(!thrown && viewTab, "宿主没有 entriesOfSlot → 照常注册（不抛错）");
}

// 详情 tab 的顺序与组件
{
  const { registrations } = run({ entryOptions: { name: "dsh-mimo-extension" } });
  const tab = registrations.find((r) => r.kind === "register" && r.id === "mimo-extension");
  ok(tab?.order === 15 && tab?.hasComponent === true, `详情 tab order=${tab?.order} 组件齐=${tab?.hasComponent}`);
}

// ---------- 胶囊形态：mi logo + 用量环（参照 dsh-codebuddy）----------
// 静态检查源码，因为这些是 JSX 结构的形状约束，mock 渲染跑不到。
{
  const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");

  ok(/function MiLogo\(/.test(src), "有 MiLogo 组件（内联 SVG，不引依赖）");
  ok(/function UsageRing\(/.test(src), "有 UsageRing 组件（手写 SVG 双圈）");
  ok(/const MI_LOGO_PATH\s*=/.test(src), "mi logo 路径内置为常量");
  // simple-icons 的 xiaomi 路径特征片段（确保是官方 shape 而非手绘近似）
  ok(/M12 0C8\.016 0 4\.756\.255 2\.493 2\.516/.test(src), "mi logo 用的是 simple-icons 官方路径");

  // 配色必须对齐 codebuddy 的 variant="mono"（用平台主题变量，主题自适应）
  // 品牌 logo 必须用**固定的品牌色**，不能用主题变量：
  // 本机主题把 --dsw-alias-brand-primary 定义为 #0f1115（近黑），
  // logo 会变成看不清的黑块（实测 computed fill = rgb(15,17,21)）。
  // codebuddy 同样如此：CodeBuddyLogo 在 variant="brand" 下写死 #6C4DFF。
  ok(/const MI_LOGO_FILL = "#ff6900"/.test(src), "mi logo 用固定品牌橙 #ff6900");
  ok(!/fill: "var\(--dsw-alias-brand-primary/.test(src), "logo 不依赖会变主题的 --dsw-alias-brand-primary（否则可能变成近黑）");
  ok(/fill: MI_LOGO_FILL/.test(src), "logo path 引用 MI_LOGO_FILL 常量");
  ok(/var\(--dsw-alias-border-l3/.test(src), "环底圈用 --dsw-alias-border-l3（同 codebuddy orbitStroke）");
  ok(/var\(--dsw-alias-label-tertiary/.test(src), "环进度圈用 --dsw-alias-label-tertiary（同 codebuddy stroke）");

  // 环的几何：从 12 点方向顺时针 + dasharray 驱动
  ok(/rotate\(-90 \$\{cx\} \$\{cx\}\)/.test(src), "环从 12 点方向起画（rotate -90）");
  ok(/strokeDasharray: `\$\{dash\} \$\{c - dash\}`/.test(src), "进度用 strokeDasharray 驱动（非 canvas）");

  // **按量付费无总量 → 只画空环**（不画误导性的 0%/100%）
  ok(
    /isPlan \? remainPercent : null/.test(src),
    "按量付费时环进度传 null（只画空环，符合「按量没法显示进度」）",
  );
  ok(/hasProgress\s*\?/.test(src), "进度圈按 hasProgress 条件渲染（null 时整圈不画）");

  // 点击弹卡片：显示计费类型 + 用量；卡片内有进详情页的入口
  ok(/t\("pill\.popover\.billing"\)/.test(src), "弹出卡显示计费类型");

  // 弹窗「已用额度」行（Credits 绝对值），仅 Token Plan
  ok(/t\("pill\.popover\.usedAmount"\)/.test(src), "弹窗有「已用额度」行");
  ok(/isPlan && unit\s*\n\s*\? line\(/.test(src), "★ 该行只在 Token Plan 下渲染");
  ok(/const planUsageUnit = summary\?\.planUsage\?\.unit \?\? ""/.test(src),
    "单位取自 planUsage.unit（官方回 Credits，不硬编码）");
  ok(/\$\{fmtFull\(unit\.used \?\? 0\)\}/.test(src), "显示 unit.used 的绝对值");
  ok(/\$\{planUsageUnit \? ` \$\{planUsageUnit\}` : ""\}/.test(src),
    "单位为空时不留下多余空格");
  // 🔴 单位必须跟在**每个**数量后面，不能只给一个 ——
  // 用户反馈："已用额度加了单位，套餐总量怎么不加单位"。
  // 更早的详情页还有第三种毛病：单位单独挂一个 span 在行尾，
  // 读者分不清它修饰的是「已用」还是「总量」。
  {
    const unitCount = (src.match(/\$\{planUsageUnit \? ` \$\{planUsageUnit\}` : ""\}/g) || []).length;
    // 5 处：弹窗 used/limit + 详情页 used/limit + 预测的「预计月底剩余」
    // （剩余额度也是官方口径，与上面的 tokens 不同单位，必须带单位）
    ok(unitCount === 5, `5 处套餐数量都带单位（弹窗 2 + 详情页 2 + 预测剩余 1，实为 ${unitCount}）`);
    ok(!/planUsage\?\.unit \? h\("span"/.test(src),
      "★ 没有孤立挂在行尾的单位 span（那种写法有歧义）");
  }  ok(/t\("pill\.popover\.plan"\)/.test(src) && /t\("pill\.popover\.payg"\)/.test(src), "计费类型区分套餐/按量两种文案");
  ok(/t\("pill\.popover\.detail"\)/.test(src), "弹出卡保留「查看详情」入口");
  ok(/activateMimoView\(props\)/.test(src), "「查看详情」仍走原 activateMimoView");

  // 弹出卡交互：点击外部 / Esc 关闭
  ok(/pointerdown/.test(src) && /Escape/.test(src), "弹出卡支持点外部与 Esc 关闭");

  // 旧的纯文字胶囊样式不应残留（避免样式死代码）
  ok(!/const pillBase = \{/.test(src), "已移除旧胶囊样式 pillBase（环形态不再需要）");

  // ---------- 尺寸必须与 dsh-codebuddy 一致（用户反馈过不一致）----------
  // codebuddy: Progress type="circle" width=26 strokeWidth=3, CodeBuddyLogo size=12
  ok(/const RING_SIZE = 26;/.test(src), "环直径 = 26（对齐 codebuddy width:26）");
  ok(/const RING_STROKE = 3;/.test(src), "环宽 = 3（对齐 codebuddy strokeWidth:3）");
  ok(/const RING_LOGO_SIZE = 12;/.test(src), "中心 logo = 12（对齐 codebuddy size:12）");
  ok(/size: RING_SIZE,/.test(src), "UsageRing 调用处用 RING_SIZE（不被 compact/narrow 缩小）");
  ok(
    !/size: compact \|\| narrow \?/.test(src),
    "环尺寸不随紧凑/窄屏变化（否则与 codebuddy 并排会大小不一）",
  );

  // ---------- 可见性：只在当前模型属于 MiMo 时显示 ----------
  // 与 codebuddy 的 codebuddyUsageVisible 同一机制（读 modelSelection 投影）。
  ok(/useProjection\("modelSelection"\)/.test(src), "读 modelSelection 投影判断当前 provider");
  ok(/projection\?\.next \?\? projection\?\.lastUsed/.test(src), "取 next 优先、lastUsed 兜底");
  ok(/if \(!providerIsMiMo\) return null;/.test(src), "非 MiMo provider 时不渲染（返回 null）");
  // 可见性门现在**优先用 host 的地址级结论**（summary.isMiMo），名字只作兜底。
  // 旧断言（只看 /mimo/i + selectedProvider）已被取代。
  ok(
    /typeof summary\?\.isMiMo === "boolean"/.test(src),
    "可见性门优先采信 host 的地址级结论 summary.isMiMo",
  );
  ok(
    /hostProvider === selectedProvider/.test(src),
    "host 结论只在它对应的 provider 上采信（切模型后不误用旧结论）",
  );
  ok(
    /return isMiMoEntry\(selectedProvider, selectedModel\)/.test(src),
    "兜底用 isMiMoEntry（provider 名或 model 名命中）",
  );
  ok(
    /\^xiaomi\(-\|\$\)\/i\.test\(p\)/.test(src),
    "isMiMoProviderName 覆盖 xiaomi / xiaomi-token-plan-*（不含 mimo 的内置 provider）",
  );
  ok(
    /const isMiMoEntry = \(provider, model\)/.test(src),
    "有 isMiMoEntry：会话明细只有 provider+model，需额外认模型名",
  );

  // isMiMoProviderName / isMiMoEntry 的实际行为（user 场景：内置 xiaomi* provider）
  {
    const st = src.indexOf("const isMiMoProviderName =");
    // 切到 splitSessionByProvider 的**函数声明**处（它的 JSDoc 注释块含未闭合的
    // `/**`，切到注释起点会把后续代码一起吞掉 → 提取出的片段语法错误）
    const en = src.indexOf("function splitSessionByProvider", st);
    const seg = src.slice(st, en);
    const { isMiMoProviderName, isMiMoEntry } = new Function(
      `${seg}\nreturn { isMiMoProviderName, isMiMoEntry };`,
    )();
    ok(isMiMoProviderName("mimo") === true, "名字规则：mimo → true");
    ok(isMiMoProviderName("xiaomi-token-plan-cn") === true, "★ 名字规则：xiaomi-token-plan-cn → true");
    ok(isMiMoProviderName("xiaomi") === true, "名字规则：xiaomi → true");
    ok(isMiMoProviderName("codebuddy") === false, "名字规则：codebuddy → false");
    ok(isMiMoProviderName("xiaomimimo") === true, "名字规则：xiaomimimo → true");
    // 会话明细只有 provider+model，模型名要能兜住
    ok(isMiMoEntry("some-proxy", "mimo-v2.5") === true, "★ entry：provider 无名但 model=mimo-v2.5 → true");
    ok(isMiMoEntry("xiaomi-token-plan-cn", "mimo-v2.5") === true, "entry：内置套餐 → true");
    ok(isMiMoEntry("codebuddy", "deepseek-v4.1-flash") === false, "entry：codebuddy/deepseek → false");
  }

  // 详情页「非 MiMo 时隐藏」开关
  ok(/hideViewWhenNotMiMo/.test(src), "详情页读取 hideViewWhenNotMiMo 偏好");
  ok(/const hideByPref = prefs\.hideViewWhenNotMiMo === true;/.test(src),
    "仅在偏好为 true 时才启用隐藏");
  ok(/t\("view\.hiddenNotMimo"\)/.test(src), "隐藏时有说明文案（不是空白页）");
  ok(/t\("cfg\.hideViewWhenNotMiMo"\)/.test(src), "设置表单有该开关");
  ok(/hideViewWhenNotMiMo,/.test(src), "保存时提交该字段");

  // 视觉路由开关
  ok(/const \[visionRouting, setVisionRouting\] = useState\(false\)/.test(src), "有 visionRouting 状态");
  ok(/setVisionRouting\(data\.visionRouting === true\)/.test(src), "载入时读取 visionRouting");
  ok(/\n\s+visionRouting,/.test(src), "保存时提交 visionRouting");
  ok(/t\("cfg\.visionRouting"\)/.test(src), "设置表单有该开关");
  ok(/t\("cfg\.visionRoutingHint"\)/.test(src), "开关带说明文案");
  // 跨命名空间写入可能失败，必须回显结果
  ok(/saved\?\.visionError/.test(src), "★ 读取 POST 返回的 visionError（失败要说出来）");
  ok(/t\("cfg\.visionFailed", \{ error: vErr \}\)/.test(src), "失败时给出原因文案");
  ok(/t\("cfg\.visionOn", \{ list: vChanged\.join\(", "\) \}\)/.test(src), "成功时列出被改的模型");
  ok(/setUiPrefs\(\{ position, wrapToolbar, hideViewWhenNotMiMo, visionRouting \}\)/.test(src),
    "保存后同步到共享 uiPrefs");
  // i18n 成对
  for (const k of ["cfg.visionRouting","cfg.visionRoutingHint","cfg.visionOn","cfg.visionOff","cfg.visionFailed"]) {
    const zh = /const zh = \{/.test(src);
    ok(src.includes(`"${k}":`), `有文案 ${k}`);
  }

  // 为纯文本模型提供视觉能力（子开关）
  ok(/const \[visionTextModels, setVisionTextModels\] = useState\(false\)/.test(src), "有 visionTextModels 状态");
  ok(/setVisionTextModels\(data\.visionRoutingTextModels === true\)/.test(src), "载入时读取该字段");
  ok(/visionRoutingTextModels: visionTextModels,/.test(src), "保存时提交该字段");
  ok(/t\("cfg\.visionTextModels"\)/.test(src), "表单有子开关");
  ok(/t\("cfg\.visionTextModelsHint"\)/.test(src), "子开关带说明");
  // ★ 子开关必须依赖主开关（关时禁用），否则单独开没有意义
  ok(/disabled: busy \|\| !visionRouting/.test(src), "★ 主开关关闭时子开关禁用");
  ok(/opacity: visionRouting \? 1 : 0\.5/.test(src), "禁用态有视觉反馈");
  // 依赖数组要带上
  ok(/visionRouting, visionTextModels, onChange\]/.test(src), "依赖数组含 visionTextModels");
  // ---------- 额度耗尽预测（09-28 用户需求）----------
  {
    // 单位换算：limit/used 是官方口径（Credits），avgDaily/monthTokens 是 tokens
    ok(/const unitsPerToken =/.test(src), "有换算率 unitsPerToken");
    ok(/usedUnits \/ local\.monthTokens/.test(src), "★ 换算率 = used / monthTokens（两种模式自动兼容）");
    // 🔴 旧写法把 Credits 与 tokens 直接相减
    ok(!/projectedRemain: limit > 0 \? Math\.max\(0, limit - projectedMonth\)/.test(src),
      "★ 已不再 Credits − tokens（那是 12% 偏差的根源）");
    ok(/Math\.max\(0, limit - \(unitsPerToken > 0 \? projectedMonth \* unitsPerToken : limit\)\)/.test(src),
      "月底剩余按同单位换算");
    // 耗尽预测
    ok(/daysToExhaust = leftUnits \/ dailyUnits/.test(src), "有耗尽天数计算");
    ok(/exhausted === "expiry"/.test(src) && /t\("view.exhaustsByQuota"\)/.test(src),
      "区分「额度耗尽」与「先到期」两种文案");
    // ⚠ Date 溢出防线（实测踩到：天数过大 → Invalid Date → 误判）
    ok(/MAX_SAFE_DAYS/.test(src), "★ 有 Date 溢出防线（天数为 1e8 量级时）");
    ok(/const daysToEnd = endValid \? \(end\.getTime\(\) - now\.getTime\(\)\) \/ 86400000/.test(src),
      "★ 判「谁先到」用天数比，不用 Date 比较（避免 Invalid Date 误判）");
    for (const k of ["view.exhaustsByQuota","view.exhaustsByExpiry","view.exhaustsValue","view.exhaustsToday","view.exhaustsNote"]) {
      ok(src.includes(`"${k}":`), `有文案 ${k}`);
    }
  }

  // ---------- 卡片填充 + widthHandle（09-28 用户反馈）----------
  {
    // ① 卡片必须能"撑满"：grid 行高由同行最高卡片决定，
    //    卡片不是 flex 纵向容器的话，子块无法认领剩余高度 → 底部留白。
    ok(/function Card\(\{ title, children \}\)/.test(src), "有 Card 组件");
    const cardSeg = src.slice(src.indexOf("function Card("), src.indexOf("function Stat("));
    ok(/flexDirection: "column"/.test(cardSeg), "★ Card 是 flex 纵向容器（子块才能 flex:1 撑满）");
    // ② 柱状图高度自适应（不能再写死像素）
    ok(/flex: "1 1 auto",\s*\n\s*minHeight: narrow \? "46px" : "60px"/.test(src),
      "柱状图容器 flex:1 认领剩余高度 + 最小高度兜底");
    ok(/Math\.round\(\(d\.tokens \/ maxDay\) \* 100\)/.test(src),
      "★ 柱高用百分比（随容器自适应），不是写死像素");
    ok(!/Math\.round\(\(d\.tokens \/ maxDay\) \* \(narrow \? 40 : 54\)\)/.test(src),
      "★ 旧的写死柱高已移除");
    ok(/minHeight: "3px"/.test(src), "柱子有最小高度（0 值也可见）");
    // ③ widthHandle：根节点必须带 data-conversation-composer-overlay
    const rootSeg = src.slice(src.indexOf("function MimoUsageView("), src.indexOf("function MimoSettingsForm("));
    ok(/"data-conversation-composer-overlay": ""/.test(rootSeg),
      "★ 视图根带 data-conversation-composer-overlay（否则平台显示拖拽手柄）");
    ok(/maxWidth: "1100px"/.test(rootSeg), "保留可读宽度上限");
  }

  // ---------- 跨作用域引用检查（09-28 修详情页空白）----------
  // 我上一轮把 `planUsageUnit` 只定义在 MimoPill，却在 MimoUsageView 里用了它，
  // 详情页一渲染就 ReferenceError → **整页空白**；而当时所有静态断言全绿。
  // 这里做作用域分析：任何"引用了只在别的顶层函数里声明的驼峰式名字"都要报。
  // （通用短名如 i/key/label 出于误报考虑不查 —— 它们多半来自嵌套箭头函数参数。）
  {
    const lines = src.split("\n");
    const matchBrace = (text, open) => {
      let depth = 0, inStr = null, inTpl = 0, inLine = false, inBlock = false;
      for (let i = open; i < text.length; i += 1) {
        const c = text[i], n = text[i + 1];
        if (inLine) { if (c === "\n") inLine = false; continue; }
        if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i += 1; } continue; }
        if (inStr) { if (c === "\\") { i += 1; continue; } if (c === inStr) inStr = null; continue; }
        if (inTpl > 0) { if (c === "\\") { i += 1; continue; } if (c === "`") inTpl -= 1; continue; }
        if (c === "/" && n === "/") { inLine = true; i += 1; continue; }
        if (c === "/" && n === "*") { inBlock = true; i += 1; continue; }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === "`") { inTpl += 1; continue; }
        if (c === "{") depth += 1;
        else if (c === "}") { depth -= 1; if (depth === 0) return i; }
      }
      return -1;
    };
    const funcs = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^    function (\w+)\s*\(([^)]*)\)\s*\{/.exec(lines[i]);
      if (!m) continue;
      const open = lines.slice(0, i).join("\n").length + lines[i].indexOf("{");
      const end = matchBrace(src, open);
      if (end < 0) continue;
      funcs.push({ name: m[1], params: m[2].split(",").map((x) => x.trim().split(/[=:]/)[0].trim()).filter(Boolean),
                   body: src.slice(open, end + 1), line: i + 1 });
    }
    const declsIn = (body) => {
      const out = new Set();
      for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
      for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
      for (const m of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g))
        for (const n of m[1].split(",")) { const t = n.split(":").pop().trim().split("=")[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t); }
      for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g))
        for (const n of m[1].split(",")) { const t = n.trim().split(/[=:]/)[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t); }
      for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
      return out;
    };
    // 模块级 = 函数之外。把函数体挖成空白再收集（否则函数内声明会被误当模块级 → 完全漏报）
    let outside = src;
    for (const f of funcs) {
      const at = src.indexOf(f.body);
      if (at < 0) continue;
      outside = outside.slice(0, at) + " ".repeat(f.body.length) + outside.slice(at + f.body.length);
    }
    const moduleLevel = declsIn(outside);
    const withOwn = funcs.map((f) => ({ ...f, own: declsIn(f.body) }));
    const crossRefs = [];
    for (const f of withOwn) {
      const others = new Set();
      for (const g of withOwn) if (g !== f) for (const n of g.own) if (!f.own.has(n)) others.add(n);
      const params = new Set(f.params);
      // 剥注释与字符串（`planUsage` 只出现在注释里也被当引用 → 误报）
      const stripped = f.body
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
        .replace(/`(?:\\.|[^`\\])*`/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, '""')
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
      for (const m of stripped.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*(?=[^\w$]*[),.;\]}:]|\s)/g)) {
        const n = m[1];
        if (!/[a-z][A-Z]/.test(n) || n.length < 8) continue;   // 只查驼峰式多词名
        if (others.has(n) && !params.has(n) && !f.own.has(n) && !moduleLevel.has(n)) {
          crossRefs.push(`${f.name}(行${f.line}) → ${n}`);
        }
      }
    }
    ok(crossRefs.length === 0,
      `★ 无跨作用域变量引用（会致整页空白）${crossRefs.length ? `：${[...new Set(crossRefs)].join("，")}` : ""}`);
  }

  for (const k of ["cfg.visionTextModels","cfg.visionTextModelsHint"]) {
    ok(src.includes(`"${k}":`), `有文案 ${k}`);
  }

  // ---------- tab 隐藏必须靠注销注册（09-27 修）----------
  // 用户反馈："开了隐藏，但 tab 还在"。
  // 根因：tab 行文字取自**注册元数据的 label**，平台这样建列表
  //   for (const entry of slots.entries("conversation.view")) tabs.push({id, label: resolveSlotLabel(entry.options.label)})
  // 组件渲染什么 tab 行根本看不到 → 组件里 return null 只能改内容，tab 照样在。
  ok(/let disposeView = null;/.test(src), "详情页注册可注销（disposeView）");
  ok(/const ensureView = \(wantShown\) =>/.test(src), "有 ensureView 控制挂出/注销");
  ok(/if \(wantShown === viewRegistered\) return;/.test(src), "状态未变时不重复注销/注册（防闪烁）");
  ok(/label: \(\) => t\("view\.label"\)/.test(src), "注册时仍带 label（tab 文字来源）");
  // 探针：apply 层拿不到 useProjection，必须靠组件回传
  // ---------- 视图根容器必须对齐平台的 flex 语义 ----------
  // 用户反馈"详情页展示方式和轨迹页不一样"。
  // 平台把 view 挂在 `.viewArea`（flex 纵向容器）里：
  //   .viewArea                       { flex-direction:column; flex:1; min-height:0; display:flex }
  //   .root[data-phase=active] .viewArea { flex:1 0 auto; min-height:auto }   ← 通常态
  // 滚动由外层 `.scrollBody`（flex:1; overflow-y:auto）负责。
  // 轨迹页的根（views.ledger）写了 `flex:1; min-width:0; min-height:0; display:flex`
  // 才撑满；我们原先什么都没写 → 按内容收缩，观感与官方视图不一致。
  {
    const st = src.indexOf('function MimoUsageView');
    const en = src.indexOf('function MimoSettingsForm', st);
    const body = src.slice(st, en);
    ok(/flex: "1 0 auto"/.test(body), "★ 视图根声明 flex:1 0 auto（对齐 viewArea 通常态）");
    ok(/minHeight: 0/.test(body), "★ 视图根声明 min-height:0（允许在 flex 容器里收缩）");
    ok(/minWidth: 0/.test(body), "视图根声明 min-width:0");
    ok(/flexDirection: "column"/.test(body), "视图根是纵向 flex 容器");
    // ⚠ 不要自己滚：滚动归平台的 scrollBody，否则出现双滚动条
    ok(!/overflowY: "auto"[\s\S]{0,120}maxWidth: "1100px"/.test(body),
      "★ 视图根不自己加 overflow-y:auto（避免双滚动，与官方视图一致）");
    ok(/maxWidth: "1100px"/.test(body), "保留可读宽度上限");
  }

  ok(/const ModelProbe = \(props\) =>/.test(src), "有 ModelProbe 探针组件");
  ok(/conversation\.composer\.dock[\s\S]{0,400}?mimo-extension-probe/.test(src),
    "探针挂在常驻槽位 composer.dock");
  ok(/return null; \/\/ 不渲染任何东西/.test(src), "探针不渲染像素");
  ok(/const onSelection = \(\{ provider, model }\) =>/.test(src), "探针经 onSelection 回传选中模型");
  // 判定与胶囊同源
  ok(/const sameProvider = latestSummary\?\.provider && latestSummary\.provider === \(provider \|\| undefined\)/.test(src),
    "tab 可见性用 host 的地址级结论（provider 一致才采信）");
  ok(/isMiMoEntry\(provider \|\| undefined, model \|\| undefined\)/.test(src),
    "兜底走 isMiMoEntry");
  // 关键安全行为
  ok(/seenSelection = false/.test(src) && /if \(!seenSelection\)/.test(src),
    "首次回传前保守显示（不知道选中什么时不隐藏）");
  ok(/ensureView\(true\); \/\/ 还不知道选了什么 → 保守显示/.test(src),
    "未知选中模型时保持挂出");
  ok(/applyTabVisibility\(\); \/\/ hideViewWhenNotMiMo 可能刚被改/.test(src),
    "偏好变化后重新评估 tab 可见性");
  ok(/if \(data\) latestSummary = data;/.test(src), "apply 层缓存 summary 供探针判定");

  // ---------- Cookie 输入框必须可粘贴 ----------
  // 用户反馈过：Cookie 是几百字符的长串，输入框不支持弹出粘贴。
  // 根因是 type="password"（浏览器对其剪贴板行为有额外限制，且内容全是圆点无法核对）。
  ok(!/type:\s*"password"/.test(src), "Cookie 输入框不再用 type=password（否则粘贴受限且看不清）");
  ok(/type:\s*"text"/.test(src), "Cookie 输入框用 type=text（可选中、可粘贴、可核对）");
  ok(/onPaste:\s*\(e\)\s*=>\s*\{/.test(src), "显式处理 onPaste（受控 input 上部分宿主不派发 onChange）");
  ok(/e\.clipboardData\?\.getData\("text"\)/.test(src), "onPaste 从 clipboardData 取文本");
  ok(/t\("cfg\.paste"\)/.test(src), "提供「粘贴」按钮");
  ok(/navigator\.clipboard\.readText\(\)/.test(src), "粘贴按钮用剪贴板 API 兜底（Ctrl+V 失效时可用）");
  ok(/t\("cfg\.pasteDone"\)/.test(src) && /t\("cfg\.pasteFail"\)/.test(src), "粘贴成功/失败都有提示");
  ok(/"data-mimo-cookie-input": ""/.test(src), "Cookie 输入框有稳定选择器（便于自检与自动化）");
  ok(/cfg\.cookieWhy/.test(src), "说明了 Cookie 的用途（读 Token Plan 套餐额度）");

  // ---------- 会话用量必须按渠道归属拆分 ----------
  // 用户反馈：本会话没用 MiMo 时详情页处理不完善。
  // 根因：一个会话可以换模型，早期版本把 session.totalTokens 整个当成
  // "MiMo 用量"与费用基数 —— 实测有会话 138.8M 里 89.1M 是 codebuddy。
  ok(/function splitSessionByProvider\(/.test(src), "有 splitSessionByProvider（按渠道归属拆分）");
  ok(/const isMiMoProviderName = \(p\) =>/.test(src), "有 isMiMoProviderName（与胶囊可见性同一规则）");
  ok(/function mimoSessionTokens\(/.test(src), "有 mimoSessionTokens 统一取值入口");
  // 汇总必须用归属后的值，而不是 session.totalTokens
  ok(/sessTokens = sessionSplit \? sessionSplit\.mimo\.tokens/.test(src), "详情页汇总用 MiMo 归属 tokens");
  ok(/sessionTokens = split \? split\.mimo\.tokens/.test(src), "胶囊用 MiMo 归属 tokens");
  ok(!/value: fmtFull\(session\.totalTokens\)/.test(src), "不再直接把 session.totalTokens 当 MiMo 用量显示");
  // 费用必须只算 MiMo 部分，混合时标注估算
  ok(/chargeIsEstimated/.test(src), "混合渠道时费用标注为估算");
  ok(/t\("view\.chargeEst"\)/.test(src), "费用标题区分精确/估算");
  ok(/t\("view\.chargeMixNote"\)/.test(src), "说明了费用为何是折算值");
  // 未细分渠道的降级路径
  ok(/attributed: false/.test(src), "无分渠道明细时标注 attributed=false");
  ok(/t\("view\.noBreakdown"\)/.test(src), "未细分渠道时有说明文案");
  // 本会话完全没用 MiMo
  ok(/t\("view\.noMimoTitle"\)/.test(src), "本会话未用 MiMo 时有明确提示标题");
  ok(/t\("view\.noMimoBody", \{/.test(src), "提示说明了套餐额度是账号级的");
  ok(/t\("view\.notMimoModel"/.test(src), "当前模型非 MiMo 时在模型卡标注");
  // 非 MiMo 行在明细表里弱化并打标
  ok(/t\("view\.notMimo"\)/.test(src), "明细表给非 MiMo 行打标");
}

// ---------- splitSessionByProvider 行为回归（用真实数据）----------
{
  const src2 = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const i = src2.indexOf("const isMiMoProviderName");
  const j = src2.indexOf("function mimoSessionTokens");
  const seg = src2.slice(i, j);
  const { splitSessionByProvider } = new Function(`${seg}\nreturn { splitSessionByProvider };`)();

  const mixed = splitSessionByProvider({
    totalTokens: 138853072,
    calls: 781,
    models: [
      { provider: "mimo", model: "mimo-v2.6-flash", totalTokens: 49771661, calls: 367 },
      { provider: "codebuddy", model: "deepseek-v4.1-flash", totalTokens: 89081411, calls: 414 },
    ],
  });
  ok(mixed.attributed === true, "混合会话：attributed=true");
  ok(mixed.mimo.tokens === 49771661, `混合会话：MiMo 只算 49,771,661（实为 ${mixed.mimo.tokens}）`);
  ok(mixed.other.tokens === 89081411, `混合会话：非 MiMo 归到 other（实为 ${mixed.other.tokens}）`);
  ok(mixed.others.length === 1 && mixed.others[0].provider === "codebuddy", "混合会话：others 按 provider 归并");
  ok(mixed.total === 138853072, "混合会话：total 仍保留全量（供占比计算）");

  const pure = splitSessionByProvider({
    totalTokens: 1000,
    calls: 5,
    models: [{ provider: "mimo", model: "x", totalTokens: 1000, calls: 5 }],
  });
  ok(pure.mimo.tokens === 1000 && pure.other.tokens === 0, "纯 MiMo 会话：全额计入");

  const none = splitSessionByProvider({
    totalTokens: 1000,
    calls: 5,
    models: [{ provider: "codebuddy", model: "x", totalTokens: 1000, calls: 5 }],
  });
  ok(none.mimo.tokens === 0 && none.other.tokens === 1000, "纯非 MiMo 会话：MiMo 为 0、全部归 other");

  const three = splitSessionByProvider({
    totalTokens: 100,
    calls: 3,
    models: [
      { provider: "mimo", model: "a", totalTokens: 40, calls: 1 },
      { provider: "codebuddy", model: "b", totalTokens: 35, calls: 1 },
      { provider: "openai-codex", model: "c", totalTokens: 25, calls: 1 },
    ],
  });
  ok(three.others.length === 2 && three.others[0].provider === "codebuddy", "多渠道：others 按 tokens 降序");
  ok(three.mimo.tokens === 40, "多渠道：MiMo 部分正确");

  const noModels = splitSessionByProvider({ totalTokens: 500, calls: 3 });
  ok(noModels.attributed === false, "无 models 明细：attributed=false（不猜测）");
  ok(noModels.mimo.tokens === 500, "无 models 明细：退回整体计入（不把用户数据抹成 0）");

  ok(splitSessionByProvider(null) === null, "session=null → 返回 null");
}

// ---------- 计费类型必须与「当前选中 provider」对齐 ----------
// 用户反馈"切回 mimo 后胶囊又变回按量付费"：可见性门读实时投影、计费行读
// host 的 60s 缓存 summary → 切模型后的窗口期两者不同步。回归盯住这条。
{
  const src5 = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const st = src5.indexOf("function billingTypeForSelection");
  let depth = 0;
  let en = -1;
  for (let k = src5.indexOf("{", st); k < src5.length; k++) {
    const c = src5[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        en = k + 1;
        break;
      }
    }
  }
  // billingTypeForSelection 依赖 isMiMoProviderName（名字线索），提取时一并带上
  const depSt = src5.indexOf("const isMiMoProviderName =");
  const depEnd = src5.indexOf("\n", src5.indexOf("^xiaomi(-|$)", depSt) >= 0
    ? src5.indexOf("^xiaomi(-|$)", depSt)
    : depSt);
  const dep = depSt >= 0 && depEnd > depSt ? src5.slice(depSt, depEnd) : "";
  const fn = new Function(`${dep}\n${src5.slice(st, en)}\nreturn billingTypeForSelection;`)();
  const B = (provider, billingType, planStatus) => ({ provider, billingType, planStatus });
  const sel = undefined;

  // 陈旧缓存 = 上一个渠道（codebuddy）时代的结果；选中已切到 mimo
  ok(fn(B("codebuddy", "payg", "active"), "mimo") === "token-plan",
    "缓存是 codebuddy/payg + 选中 mimo(active) → 本地纠正为 token-plan");
  ok(fn(B("codebuddy", "payg", "expired"), "mimo") === "payg",
    "选中 mimo 但套餐已过期 → payg");
  ok(fn(B("codebuddy", "payg", "none"), "mimo") === "payg",
    "选中 mimo 但官方明确无订阅 → payg");
  ok(fn(B("codebuddy", "payg", "unknown"), "mimo") === "token-plan",
    "选中 mimo、套餐状态未知 → 保守判套餐（与 host 规则一致）");
  // 反方向：缓存还是 mimo/套餐，用户已切到 codebuddy
  ok(fn(B("mimo", "token-plan", "active"), "codebuddy") === "payg",
    "缓存是 mimo/套餐 + 选中 codebuddy → payg");
  ok(fn(B("codebuddy", "token-plan", "active"), "xiaomi-token-plan-cn") === "token-plan",
    "选中 provider 名含 token-plan → 套餐");
  ok(fn(B("mimo", "payg", "active"), sel) === "payg",
    "拿不到选中模型 → 信 host（不猜）");
  ok(fn(B("mimo", "payg", "active"), "mimo") === "payg",
    "provider 一致 → 信 host 的结论");
  ok(fn(null, "mimo") === "token-plan",
    "summary 缺失 → 保守默认 token-plan");

  // 必须真的走到 force 刷新，否则修复只完成一半
  ok(/rpc\("summary", force \? \{ refresh: "1" \} : undefined\)/.test(src5),
    "refresh(force) 会带 refresh=1 绕过 host 60s 缓存");
  ok(/if \(selectedProvider\) refresh\(true\);/.test(src5),
    "选中 provider 变化时强制刷新");
  ok(/const billingType = billingTypeForSelection\(summary, selectedProvider\)/.test(src5),
    "弹窗计费行走共享判定（非直读 summary）");
  ok(/const billingType = billingTypeForSelection\(summary, modelProvider\)/.test(src5),
    "详情页计费类型也走共享判定");
}

// ---------- i18n 一致性（这条曾抓到真 bug：view.notMimo 用了但没定义）----------
{
  const src3 = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const used = new Set([...src3.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]));
  // ⚠ 用**大括号配对**切块，不能找第一个 `};` ——
  // 块里只要出现一次以 `};` 结尾的行（嵌套对象/多行值），切片就会提前截断，
  // 于是后半段 key 全被误判成"缺英文/缺中文"。
  // 我加登录引导文案时就踩到了：14 条已存在的 key 被报成缺失。
  const sliceObject = (marker) => {
    const at = src3.indexOf(marker);
    if (at < 0) return "";
    let i = src3.indexOf("{", at);
    if (i < 0) return "";
    let depth = 0;
    for (let k = i; k < src3.length; k += 1) {
      if (src3[k] === "{") depth += 1;
      else if (src3[k] === "}") {
        depth -= 1;
        if (depth === 0) return src3.slice(i, k + 1);
      }
    }
    return src3.slice(i);
  };
  const zhStart = src3.indexOf("const zh = {");
  const enStart = src3.indexOf("const en = {");
  const zhBlock = src3.slice(zhStart, enStart);
  const enBlock = sliceObject("const en = {");
  const keysOf = (block) => new Set([...block.matchAll(/"([a-zA-Z0-9_.]+)":/g)].map((m) => m[1]));
  const zhKeys = keysOf(zhBlock);
  const enKeys = keysOf(enBlock);

  // ⚠ 块内**重复 key** 必须单独查 —— 上面用 Set 会天然去重，看不见重复。
  // 实测踩过：英文行被插进 zh 块，JS 对象字面量"后者覆盖前者"，
  // 于是中文界面显示了英文，而所有 key 集合比对全部通过。
  const dupOf = (block) => {
    const seen = new Map();
    for (const m of block.matchAll(/"([a-zA-Z0-9_.]+)":/g)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  };
  const zhDup = dupOf(zhBlock);
  const enDup = dupOf(enBlock);
  ok(zhDup.length === 0, `zh 块内无重复 key${zhDup.length ? `（${zhDup.join(",")}）` : ""}`);
  ok(enDup.length === 0, `en 块内无重复 key${enDup.length ? `（${enDup.join(",")}）` : ""}`);

  // ⚠ 反向校验：切块必须覆盖到块的**真正结尾**。
  // 只要文案里出现 `};` 这样的字符序列（例如 `...{end}; used...`），
  // 朴素的"找第一个 };" 就会截断，把后半段 key 全报成缺失。
  // 这里断言切出来的 en 块与真结尾一致 —— 以后再加这类文案会立刻暴露。
  {
    let depth = 0;
    let realEnd = -1;
    for (let k = src3.indexOf("{", enStart); k < src3.length; k += 1) {
      if (src3[k] === "{") depth += 1;
      else if (src3[k] === "}") {
        depth -= 1;
        if (depth === 0) { realEnd = k; break; }
      }
    }
    ok(realEnd > 0 && enBlock.length === realEnd - src3.indexOf("{", enStart) + 1,
      "★ en 块切到真结尾（文案里出现 `};` 也不会截断）");
  }

  const missingZh = [...used].filter((k) => !zhKeys.has(k));
  const missingEn = [...used].filter((k) => !enKeys.has(k));
  ok(missingZh.length === 0, `t() 用到的 key 都有中文文案${missingZh.length ? `（缺 ${missingZh.join(",")}）` : ""}`);
  ok(missingEn.length === 0, `t() 用到的 key 都有英文文案${missingEn.length ? `（缺 ${missingEn.join(",")}）` : ""}`);
  // 中英必须成对，避免只补一边
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  ok(onlyZh.length === 0, `中文文案都有对应英文${onlyZh.length ? `（${onlyZh.join(",")}）` : ""}`);
  ok(onlyEn.length === 0, `英文文案都有对应中文${onlyEn.length ? `（${onlyEn.join(",")}）` : ""}`);

  // 占位符一致性：t(key,{v}) 的 v 必须出现在文案里，否则界面上会原样显示 {v}
  const badPlaceholder = [];
  for (const m of src3.matchAll(/\bt\("([a-zA-Z0-9_.]+)",\s*\{([^}]*)\}/g)) {
    const key = m[1];
    const vars = [...m[2].matchAll(/([a-zA-Z0-9_]+):/g)].map((x) => x[1]);
    const zhv = zhBlock.match(new RegExp(`"${key.replace(/\./g, "\\.")}": "([^"]*)"`));
    const env = enBlock.match(new RegExp(`"${key.replace(/\./g, "\\.")}": "([^"]*)"`));
    for (const v of vars) {
      if (zhv && !zhv[1].includes(`{${v}}`)) badPlaceholder.push(`${key}(zh) 缺 {${v}}`);
      if (env && !env[1].includes(`{${v}}`)) badPlaceholder.push(`${key}(en) 缺 {${v}}`);
    }
  }
  ok(badPlaceholder.length === 0, `文案占位符与调用一致${badPlaceholder.length ? `（${badPlaceholder.join("; ")}）` : ""}`);
}

// ---------- 弹层定位：必须 portal + 真实测量 + 双向钳制 ----------
// 用户两次反馈"弹窗在屏幕外"：① 胶囊在工具栏右侧 → 向右溢出；
// ② 胶囊在**标题栏** → 贴顶，向上弹出跑出屏幕。
// 根治办法与平台 Tooltip 原语一致：createPortal 挂到 body + 测量真实尺寸 + 钳制。
{
  const src4 = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  ok(/require\("react-dom"\)/.test(src4), "require react-dom（拿 createPortal）");
  ok(/createPortal\(popoverBody, document\.body\)/.test(src4), "弹层用 createPortal 挂到 document.body");
  ok(/const popRef = useRef\(null\)/.test(src4), "弹层有 ref 用于测量真实尺寸");
  ok(/function placePopover|const placePopover = useCallback/.test(src4), "有 placePopover 定位函数");
  // 真实测量（不是硬编码估算）
  ok(/pop\.getBoundingClientRect\(\)/.test(src4), "测量弹层真实尺寸");
  ok(/const height = p\.height > 0 \? p\.height : 200/.test(src4), "高度优先用实测值，量不到才退回估算");
  // 双向钳制：水平 + 垂直都要夹进视口
  ok(/if \(left \+ width > vw - M\) left = vw - M - width/.test(src4), "水平越界时左移");
  ok(/if \(left < M\) left = M/.test(src4), "水平越界时贴左");
  ok(/if \(top < M\) top = M/.test(src4), "垂直越界时贴顶");
  ok(/if \(top \+ height > vh - M\) top = Math\.max\(M, vh - M - height\)/.test(src4), "垂直越界时上移夹进视口");
  // 上下翻转按真实空间判断
  ok(/const spaceAbove = a\.top - M/.test(src4) && /const spaceBelow = vh - a\.bottom - M/.test(src4), "分别算上下可用空间");
  ok(/spaceAbove >= need/.test(src4) && /spaceBelow >= need/.test(src4), "按空间决定向上/向下弹");
  // 跟随 resize / 滚动（标题栏会随滚动移动）
  ok(/addEventListener\("resize", placePopover\)/.test(src4), "resize 时重算位置");
  ok(/addEventListener\("scroll", placePopover, true\)/.test(src4), "滚动时重算位置（捕获阶段）");
  // 弹层自身可滚动兜底，内容再高也不会溢出
  ok(/maxHeight: `\$\{popPos\.maxHeight\}px`/.test(src4), "弹层高度受视口限制");
  ok(/overflowY: "auto"/.test(src4), "内容过高时弹层内部滚动");

  // 几何回归：抽出真实 placePopover 逻辑，跑多视口 × 多座位矩阵。
  // 覆盖用户反馈的两个场景：胶囊在工具栏右侧（向右溢出）、
  // 胶囊在标题栏（贴顶，向上弹出跑到屏幕外）。
  {
    const st = src4.indexOf("const placePopover = useCallback(() => {");
    const op = src4.indexOf("{", st);
    let depth = 0;
    let en = -1;
    for (let k = op; k < src4.length; k++) {
      const c = src4[k];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          en = k + 1;
          break;
        }
      }
    }
    if (st < 0 || en < 0) {
      fail.push("无法提取 placePopover 做几何回归");
    } else {
      const body = src4.slice(op + 1, en - 1);
      const run = new Function(
        "rootRef",
        "popRef",
        "window",
        "document",
        `let out=null; const setPopPos=(v)=>{out=v};
${body}
return out;`,
      );
      const mk = (l, t, r, b) => ({
        getBoundingClientRect: () => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }),
      });
      const VW = (width, height) => ({ innerWidth: width, innerHeight: height });
      const DOC = { documentElement: { clientWidth: 0, clientHeight: 0 } };
      const POPW = 260;
      const POPH = 194; // 实测弹层高度
      const cases = [
        ["header 贴顶 桌面", mk(1200, 12, 1240, 36), VW(1400, 900)],
        ["header 贴顶 移动", mk(300, 12, 340, 36), VW(390, 844)],
        ["header 贴顶 极窄", mk(240, 12, 280, 36), VW(320, 568)],
        ["header 贴顶 极矮横屏", mk(700, 8, 740, 32), VW(800, 360)],
        ["toolbar 贴右 移动", mk(330, 700, 370, 724), VW(390, 844)],
        ["toolbar 贴右 极窄", mk(260, 440, 300, 464), VW(320, 568)],
        ["toolbar 贴底右 桌面", mk(1300, 860, 1340, 884), VW(1400, 900)],
        ["toolbar 贴底右 极矮", mk(750, 330, 790, 354), VW(800, 360)],
      ];
      const bad = [];
      for (const [name, anchor, vp] of cases) {
        const r = run({ current: anchor }, { current: mk(0, 0, POPW, POPH) }, vp, DOC);
        if (!r) {
          bad.push(`${name}(null)`);
          continue;
        }
        const right = r.left + r.width;
        const bottom = r.top + POPH;
        if (!(r.left >= -1 && r.top >= -1 && right <= vp.innerWidth + 1 && bottom <= vp.innerHeight + 1)) {
          bad.push(`${name}(${r.left.toFixed(0)},${r.top.toFixed(0)}→${right.toFixed(0)},${bottom.toFixed(0)} vs ${vp.innerWidth}x${vp.innerHeight})`);
        }
      }
      ok(bad.length === 0, `弹层几何：${cases.length} 个场景全部落在视口内${bad.length ? `（越界：${bad.join("; ")}）` : ""}`);
      // header 贴顶时必须是"翻到下方"，而不是被夹在顶部遮住内容
      const hdr = run({ current: mk(1200, 12, 1240, 36) }, { current: mk(0, 0, POPW, POPH) }, VW(1400, 900), DOC);
      ok(hdr && hdr.top >= 36, "标题栏贴顶时弹层翻到锚点下方（不被夹在顶部）");
    }
  }
}

// ---------- 输出 ----------
console.log("通过：");
for (const line of pass) console.log(`  ✓ ${line}`);
if (fail.length) {
  console.log("\n失败：");
  for (const line of fail) console.log(`  ✗ ${line}`);
  console.log(`\n>>> ${fail.length} 项未通过`);
  process.exit(1);
}
console.log(`\n>>> client 端 ${pass.length} 项检查全部通过`);
