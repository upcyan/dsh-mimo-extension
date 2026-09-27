// @ts-check
/**
 * dsh-mimo-usage — DeepSeek Harness 宿主插件
 *
 * 功能：
 *   /mimo          查看 MiMo 额度（套餐剩余 / 本地估算）
 *   工具 mimo_usage —— 让模型自己查询额度与用量
 *   /api/dsh-mimo-usage/*  供浏览器胶囊与详情页轮询的 JSON 路由
 *
 * 数据来源（按优先级）：
 *   1. 小米官方控制台接口（需 Cookie：platform.xiaomimimo.com/api/v1/{balance,tokenPlan/detail,tokenPlan/usage}）
 *   2. 本地估算：$DSH_HOME/token-usage/usage-*.jsonl 按天聚合 + config.mimo.planTotalTokens 兜底总量
 *   3. 内置会话统计（本插件自备）：目录缺失 / `dsh-token-usage-counter` 未装配时，
 *      直接从 session 事件（`assistant/message.usage`）统计，保证「今日/本月 tokens」
 *      与「当前会话用量」不会恒为 0。
 *
 * 计费类型（自动推断，可 config.mimo.billingTypeOverrides 覆盖）：
 *   provider 含 "token-plan" → token-plan（套餐）
 *   否则 → payg（按量计费）
 *
 * 无运行时依赖，直接以绝对路径加载。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

export const name = "mimo-usage";

/**
 * 强依赖：命令与工具注册表。
 * webServer 走 ctx.inject 软依赖，缺失时插件仍能加载（headless 组合）。
 */
export const inject = ["commands", "tools", "settings"];

const DEFAULT_MIMO_API = "https://platform.xiaomimimo.com/api/v1";
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60_000;

/** settings.yaml 里的配置命名空间。 */
const SETTINGS_NS = "dsh-mimo-usage";

/**
 * 宿主路由前缀。刻意【不用】`/api/*`。
 *
 * 原因：DSH 核心对 `/api` 前缀有一条严格的 Host/Origin fence
 *（`dsh-client-connection` 的 `isTrustedApiRequest`）：
 *
 *   1. `Host` 必须是 loopback（localhost / 127.x）或是启动参数里
 *      `--trusted-host` 列出的 authority；
 *   2. 且 `Origin.host` 必须【完全等于】`Host`。
 *
 * 经 fnOS nginx 反代（`https://<域名>/app/fn-deepseek-harness/...`）访问时，
 * nginx 会把 `Host` 改写成 `localhost`（见 `/usr/trim/nginx/logs/error.log`），
 * 而浏览器发的 `Origin` 是实际域名 → 第 2 条永远不成立 → 一律 **403 forbidden**。
 *
 * 非 `/api` 前缀没有这层 fence（对照：`dsh-prompt-manager` 用 `/dsh-prompt-manager`）。
 *
 * ⚠️ 配套要求：该前缀必须登记进 fnOS 网关的路径白名单（`gatewayProxyPaths`），
 * 否则浏览器 bridge 不会给请求补 `/app/` 前缀，nginx 会把它当静态文件去
 * `/usr/trim/www/` 找而返回 404。登记方式见 README「接口路径」一节。
 */
const ROUTE_PREFIX = "/dsh-mimo-usage";

/**
 * 设置值的规范化 + 类型兜底（**不再是 schema 本体**）。
 *
 * ⚠ 这里曾经直接被注册进 `ctx.settings.register(ns, schema)`，注释还写着
 * 「register 只要求 schema 是可调用且返回解析值的函数」—— 那句话在
 * `resolve()` 路径上成立，在 **describe() 路径上是错的**：
 *
 *   dsh-settings/lib/index.js:363   schema: registration.schema.toJSON()
 *   （在 `.map()` 里裸调用，只有上面取 section 那段有 try/catch）
 *   dsh-api-settings-controller:429  settings.describe({...}).map(...)  也不兜底
 *
 * 一个手写普通函数没有 `toJSON`，于是**所有**命名空间的 describe 一起抛
 * `TypeError` → 设置 → 插件页整体拿不到数据（连带 prompt-manager 等其它插件
 * 的设置页一起失效，见 MEMORY.md §三的根因记录）。
 * 另外 `redactSecrets()` 靠 `schema.type` / `schema.dict` 遍历结构，
 * 缺了它 cookie 明文会随 describe 响应过线 —— 与 README 的「Cookie 不回传
 * 浏览器」承诺相悖。
 *
 * 现在本函数只负责「把任意输入洗成类型正确的值」（脏输入绝不抛错），
 * 真正的 schema 由 `buildMimoSettingsSchema()` 用真 schemastery 构造：
 * 自带 toJSON / type / dict，并把 cookie 标成 `role: 'secret'`。
 */
function mimoSettingsSchema(input) {
  const src = input && typeof input === "object" ? input : {};
  const mimo = src.mimo && typeof src.mimo === "object" ? src.mimo : {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const str = (v, fallback) => (typeof v === "string" ? v : fallback);
  const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
  const positions = ["header", "toolbar", "above", "hidden"];
  const pricing = mimo.pricing && typeof mimo.pricing === "object" ? mimo.pricing : {};
  const fallbackPrice = pricing.fallbackPrice && typeof pricing.fallbackPrice === "object" ? pricing.fallbackPrice : {};
  return {
    mimo: {
      cookie: str(mimo.cookie, ""),
      cookieRef: str(mimo.cookieRef, "MIMO_CONSOLE_COOKIE"),
      planTotalTokens: num(mimo.planTotalTokens, 500_000_000),
      pillPosition: positions.includes(mimo.pillPosition) ? mimo.pillPosition : "header",
      wrapToolbar: bool(mimo.wrapToolbar, true),
      billingTypeOverrides:
        mimo.billingTypeOverrides && typeof mimo.billingTypeOverrides === "object" ? mimo.billingTypeOverrides : {},
      pricing: {
        ...pricing,
        fallbackPrice: {
          input: num(fallbackPrice.input, 0),
          output: num(fallbackPrice.output, 0),
          cacheRead: num(fallbackPrice.cacheRead, 0),
          cacheWrite: num(fallbackPrice.cacheWrite, 0),
        },
      },
    },
  };
}

/**
 * 解析真 schemastery 工厂。
 *
 * 插件自身目录里没有 node_modules，所以锚点都指向「能解析到 dsh 依赖树」的位置：
 *   1. `ctx.baseUrl` → profile 目录（部署时 `profiles/node_modules` 是与 core
 *      同步的软链树，能解析到）。注意 Cordis 上下文是 Proxy，读未声明的属性会
 *      **直接抛错**，所以整段必须包 try —— 可选链 `?.` 也挡不住。
 *   2. `import.meta.url` —— 插件若被装进带依赖树的目录
 *   3. `process.argv[1]` —— dsh 启动入口 bin.js，必然能解析 core 自己的依赖
 *   4. 进程 cwd
 *
 * @param {any} ctx 插件上下文（可为普通对象，测试时直接给 baseUrl）
 * @returns {any} schemastery 工厂；拿不到时 undefined
 */
function loadSchemaFactory(ctx) {
  const anchors = [];
  try {
    if (typeof ctx?.baseUrl === "string" && ctx.baseUrl.length > 0) {
      anchors.push(new URL("./__anchor__.js", ctx.baseUrl).href);
    }
  } catch {
    /* Proxy 上读 baseUrl 可能抛 —— 吞掉，换下一个锚点 */
  }
  anchors.push(import.meta.url);
  if (typeof process.argv?.[1] === "string" && process.argv[1]) anchors.push(process.argv[1]);
  try {
    anchors.push(new URL("./__anchor__.js", `file://${process.cwd()}/`).href);
  } catch {
    /* cwd 不可转 URL 就跳过 */
  }

  for (const anchor of anchors) {
    try {
      const loaded = createRequire(anchor)("@deepseek-ai/schemastery");
      const factory = typeof loaded === "function" ? loaded : loaded?.default;
      // 只接受真正的 schemastery：必须带 object / array 构造器
      if (typeof factory === "function" && typeof factory.object === "function" && typeof factory.array === "function") {
        return factory;
      }
    } catch {
      /* 换下一个锚点 */
    }
  }
  return undefined;
}

/**
 * 用真 schemastery 构造可注册的设置 schema。
 *
 * 返回 undefined 表示拿不到 schemastery —— 调用方必须**跳过注册**，绝不能退回
 * 手写函数：注册一个没有 `toJSON` 的 schema 会让 describe() 抛错，进而让**所有**
 * 插件的设置页拿不到数据（见 mimoSettingsSchema 的注释）。
 * 不注册的代价是本插件配置在 GUI 里只读（GET 回 writable:false、POST 回 503），
 * 但 patch 层 config 照常生效，其它插件的设置页也不受影响。
 *
 * 返回的 schema 必须同时满足三件事，缺一不可：
 *   1. 可调用、返回解析值 —— resolve() 的硬要求；
 *   2. 带 `toJSON()` —— describe() 会调用，客户端还要用它反序列化；
 *   3. 暴露 `type` / `dict` —— redactSecrets() 的 walker 靠它们遍历，
 *      否则 cookie 明文会随 describe 响应过线。
 *
 * @param {any} ctx 插件上下文
 * @returns {any} 可注册的 schema；不可用时 undefined
 */
export function buildMimoSettingsSchema(ctx) {
  const factory = loadSchemaFactory(ctx);
  if (!factory) return undefined;

  const inner = factory.object({
    mimo: factory.object({
      // 控制台 Cookie 是凭据：标 secret 后 describe() 会剥掉它并回传写入槽位
      cookie: factory.string().default("").role("secret"),
      cookieRef: factory.string().default("MIMO_CONSOLE_COOKIE"),
      planTotalTokens: factory.number().default(500_000_000),
      pillPosition: factory.string().default("header"),
      wrapToolbar: factory.boolean().default(true),
      // 动态键（provider 或 provider/model），结构由 mimoSettingsSchema 兜底。
      // 注意 schemastery 的 dict 签名是 dict(值, 键) —— 第一个参数是 inner(值)。
      billingTypeOverrides: factory.dict(factory.any(), factory.string()).default({}),
      pricing: factory.dict(factory.any(), factory.string()).default({}),
    }),
  });

  // 先用手工规范化把脏输入洗平（它不抛错），再过真 schema 拿默认值与类型校验
  const tolerant = (input) => inner(mimoSettingsSchema(input));

  tolerant.toJSON = () => inner.toJSON();
  tolerant.type = inner.type;
  tolerant.dict = inner.dict;
  tolerant.meta = inner.meta;
  tolerant.toString = () => inner.toString();
  if (inner["~standard"] !== undefined) tolerant["~standard"] = inner["~standard"];
  return tolerant;
}

/** 读取请求体 JSON（限制大小，避免拖垮进程）。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let done = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        done = true;
        reject(new Error("请求体过大"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`));
      }
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

const DEFAULT_CONFIG = {
  mimo: {
    cookie: "",
    cookieRef: "MIMO_CONSOLE_COOKIE",
    planTotalTokens: 500_000_000,
    billingTypeOverrides: {},
    pricing: {
      fallbackPrice: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  },
};

/** 深合并默认配置（对象逐键递归，数组与标量直接覆盖）。 */
function mergeConfig(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== "object" || typeof override !== "object") return override;
  const out = { ...base };
  for (const key of Object.keys(override)) out[key] = mergeConfig(base[key], override[key]);
  return out;
}

/** 读取 Cookie：config.mimo.cookie > 凭据引用 > 环境变量。 */
async function resolveCookie(ctx, mimo) {
  const direct = typeof mimo.cookie === "string" ? mimo.cookie.trim() : "";
  if (direct) return { cookie: direct, source: "config" };

  const ref = (typeof mimo.cookieRef === "string" && mimo.cookieRef.trim()) || DEFAULT_CONFIG.mimo.cookieRef;
  try {
    const credentials = ctx.get?.("credentials");
    if (credentials && typeof credentials.resolve === "function") {
      const hit = await credentials.resolve(ref);
      if (hit && typeof hit.value === "string" && hit.value.trim()) {
        return { cookie: hit.value.trim(), source: `credential:${ref}` };
      }
    }
  } catch {
    /* 凭据服务不可用时继续走环境变量 */
  }
  const ambient = (process.env[ref] ?? "").trim();
  if (ambient) return { cookie: ambient, source: `env:${ref}` };
  return { cookie: "", source: "none" };
}

/** 带超时的 GET JSON，返回 [ok, data|errorText]。 */
async function fetchJson(url, cookie, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return [false, `HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`];
    }
    return [true, await res.json()];
  } catch (error) {
    return [false, error instanceof Error ? error.message : String(error)];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** 官方 tokenPlan/detail → {planCode, periodEnd, expired} 或 null。 */
function parseTokenPlanDetail(raw) {
  if (!raw || raw.code !== 0 || !raw.data) return null;
  const d = raw.data;
  return {
    planCode: typeof d.planCode === "string" ? d.planCode : "",
    periodEnd: typeof d.currentPeriodEnd === "string" ? d.currentPeriodEnd : "",
    expired: d.expired === true,
  };
}

/**
 * 官方 tokenPlan/detail → 套餐状态（用于判定计费类型）。
 *
 *   active   有效套餐；expired 套餐已过期；none 接口明确说「没有订阅」；
 *   unknown  拿不到结论（没配 Cookie / 请求失败 / code 非 0）。
 *
 * 区分 `none` 与 `unknown` 很重要：`none` 是官方的**否定结论**（该按量计费），
 * `unknown` 只是「我们不知道」，不能据此把小米通道判成按量。
 *
 * @param {boolean} ok - 请求是否成功
 * @param {any} raw - 原始响应
 * @param {{expired?: boolean} | null} parsed - parseTokenPlanDetail 的结果
 * @returns {"active"|"expired"|"none"|"unknown"}
 */
export function planStatusOf(ok, raw, parsed) {
  if (!ok || !raw || raw.code !== 0) return "unknown";
  if (parsed) return parsed.expired ? "expired" : "active";
  return "none";
}

/** 官方 tokenPlan/usage → {percent, items[]} 或 null。 */
/**
 * Token Plan 额度项字段名 → 人类可读标签。
 *
 * 官方 `tokenPlan/usage` 返回的 `items[].name` 是字段键（如 `month_total_token`），
 * 直接展示会很突兀。这里映射成可读文案，未知键原样保留。
 */
const PLAN_ITEM_LABELS = {
  month_total_token: "本月套餐额度",
  plan_total_token: "套餐总额度",
  compensation_total_token: "补偿额度",
};

/** 把额度明细整体换算：Token Plan 的单位是 Credits，不是 tokens。 */
function normalizePlanUsage(usage) {
  if (!usage) return usage;
  return {
    ...usage,
    unit: "Credits",
    items: (usage.items ?? []).map((it) => ({
      ...it,
      label: PLAN_ITEM_LABELS[it.name] ?? it.name,
    })),
  };
}

/**
 * 官方 `percent` 字段 → 0~100 的百分数。
 *
 * ⚠️ 官方返回的是 **比值（0~1）**，不是百分数。2026-09-25 实测
 * `tokenPlan/usage`：
 *
 *   monthUsage.items[0] = { used: 4725102737, limit: 49200000000, percent: 0.0960 }
 *   used / limit = 0.096038…          ← 与 percent 完全吻合（比值口径）
 *   Lite 年度套餐 = 492 亿 Credits      ← limit 与官方定价页一致
 *
 * 控制台前端的换算（platform.xiaomimimo.com 主 bundle，module 4879）是：
 *
 *   function Zn(e){ return Math.min(100, Math.max(0, 100 * e)) }
 *
 * 即 0.0960 → **9.6%**。早期版本直接把 `percent` 当百分数显示，
 * 结果「本月已用」只有真实值的 1/100（0.096 显示成 0.10%）。
 *
 * 兼容性：若某天官方改回 0~100 口径（n > 1），按原值使用，不再乘 100。
 *
 * @param {unknown} raw - 官方 percent
 * @param {unknown} used - 该条 used（percent 缺失时的兜底分子）
 * @param {unknown} limit - 该条 limit（percent 缺失时的兜底分母）
 * @returns {number} 0~100 的百分数
 */
export function toPercent(raw, used, limit) {
  // toFixed(6) 顺带消掉 100*0.096=9.600000000000001 这类浮点尾巴
  const clamp = (v) => Number(Math.min(100, Math.max(0, v)).toFixed(6));
  const n = Number(raw);
  if (Number.isFinite(n) && n !== 0) return clamp(n <= 1 ? n * 100 : n);
  // percent 缺失或为 0：用 used/limit 复算，避免小用量被四舍五入抹成 0
  const u = Number(used);
  const l = Number(limit);
  if (Number.isFinite(u) && Number.isFinite(l) && l > 0) return clamp((u / l) * 100);
  return Number.isFinite(n) ? clamp(n) : 0;
}

/**
 * 官方 tokenPlan/usage → {percent, items[]} 或 null。
 * 所有 percent 统一经 `toPercent()` 归一到 0~100。
 */
export function parseTokenPlanUsage(raw) {
  if (!raw || raw.code !== 0 || !raw.data || !raw.data.monthUsage) return null;
  const m = raw.data.monthUsage;
  const items = Array.isArray(m.items) ? m.items : [];
  const first = items[0];
  return normalizePlanUsage({
    percent: toPercent(m.percent, first?.used, first?.limit),
    items: items.map((it) => ({
      name: String(it?.name ?? ""),
      used: Number(it?.used) || 0,
      limit: Number(it?.limit) || 0,
      percent: toPercent(it?.percent, it?.used, it?.limit),
    })),
    // 官方同时给出 usage 明细（含补偿额度），有则一并带出
    extra: Array.isArray(raw.data.usage?.items)
      ? raw.data.usage.items.map((it) => ({
          name: String(it?.name ?? ""),
          used: Number(it?.used) || 0,
          limit: Number(it?.limit) || 0,
          percent: toPercent(it?.percent, it?.used, it?.limit),
        }))
      : [],
  });
}

/** 官方 balance → {balance, currency, cashBalance, giftBalance} 或 null。 */
function parseBalance(raw) {
  if (!raw || raw.code !== 0 || !raw.data) return null;
  const d = raw.data;
  return {
    balance: String(d.balance ?? "0"),
    currency: String(d.currency ?? "CNY"),
    cashBalance: String(d.cashBalance ?? d.balance ?? "0"),
    giftBalance: String(d.giftBalance ?? "0"),
  };
}

/**
 * 聚合本地 usage-*.jsonl（本月与今日 tokens、按天、按模型）。
 *
 * 目录不存在时**不算故障**：`token-usage/` 由 `dsh-token-usage-counter` 写入，
 * 该插件未装配（或还没跑过任何请求）时目录就是不存在的。早期版本把 ENOENT
 * 当错误回给详情页 / `/mimo` 命令，于是「用量统计（本地）」永远显示
 * `ENOENT: no such file or directory, scandir '.../token-usage'`。
 * 现在按「暂无记录」处理（ok=true + missing=true + note），
 * 数据缺口由调用方改用内置会话统计兜底。
 *
 * @param {string} dshHome - DSH 主目录
 */
export async function aggregateLocalUsage(dshHome) {
  const dir = join(dshHome, "token-usage");
  const stats = {
    ok: false,
    error: "",
    note: "",
    missing: false,
    source: "token-usage",
    dir,
    monthTokens: 0,
    todayTokens: 0,
    today: "",
    days: [],
    models: [],
    updatedAt: Date.now(),
  };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const monthPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-`;
  const todayKey = `${monthPrefix}${pad(now.getDate())}`;
  stats.today = todayKey;

  try {
    const files = (await readdir(dir)).filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"));
    const dayMap = new Map();
    const modelMap = new Map();

    for (const file of files) {
      const dateKey = file.slice("usage-".length, -".jsonl".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      if (!dateKey.startsWith(monthPrefix)) continue;
      const text = await readFile(join(dir, file), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const u = rec?.usage ?? {};
        const tokens =
          (Number(u.inputTokens) || 0) +
          (Number(u.outputTokens) || 0) +
          (Number(u.cacheReadTokens) || 0) +
          (Number(u.cacheWriteTokens) || 0);
        if (tokens <= 0) continue;

        const day = dayMap.get(dateKey) ?? { date: dateKey, tokens: 0, calls: 0 };
        day.tokens += tokens;
        day.calls += 1;
        dayMap.set(dateKey, day);

        const model = String(rec?.model ?? "unknown");
        const m = modelMap.get(model) ?? { model, tokens: 0, calls: 0 };
        m.tokens += tokens;
        m.calls += 1;
        modelMap.set(model, m);

        stats.monthTokens += tokens;
        if (dateKey === todayKey) stats.todayTokens += tokens;
      }
    }

    stats.days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    stats.models = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens);
    stats.ok = true;
  } catch (error) {
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") {
      // 目录还没被写出来：按「暂无记录」处理，而不是抛 ENOENT 当故障
      stats.ok = true;
      stats.missing = true;
      stats.note = `目录不存在：${dir}（dsh-token-usage-counter 未装配或尚无记录）`;
    } else {
      stats.error = error instanceof Error ? error.message : String(error);
    }
  }
  stats.updatedAt = Date.now();
  return stats;
}

/**
 * 内置会话 / 本日本月用量统计 —— `dsh-token-usage-counter` 缺席时的回退。
 *
 * 为什么必须有：`$DSH_HOME/token-usage/usage-*.jsonl` 与 `ctx.tokenUsageCounter`
 * 都由 `dsh-token-usage-counter` 提供，而它并不总在 profile 里（本机当前 profile
 * 就没装）。缺席时的两处症状：
 *   1. `token-usage/` 目录不存在 → 本地统计永远 ENOENT；
 *   2. `/dsh-mimo-usage/session` 恒返回 null → 胶囊与详情页的
 *      「当前会话用量」恒为 0（summary.sessionTokens 也取不到）。
 *
 * 本实现直接读会话事件流自建统计（`assistant/message.data.usage`）：
 *   - **只读不写**：不落盘、不与 dsh-token-usage-counter 抢同一批文件；
 *     它一旦装配，`buildSummary` / `sessionUsagePayload` 会优先用它的数据。
 *   - **按事件 `seq` 去重**：重复扫描不会重复计数（事件被 compaction 裁剪也安全）。
 *   - **惰性刷新**：只在 `/session`、`/summary` 被请求时扫描（≤1 次 / 60s），
 *     不订阅 `session/event` —— 那会在每个事件上都遍历一遍事件数组。
 *
 * 口径：统计的是**进程启动以来、当前仍存活的会话**，重启即归零，
 * 因此调用方要把它标注成 `source: "session-events"`，与落盘统计区分。
 *
 * @param {object} ctx - Cordis 上下文
 */
export function createLocalUsageCounter(ctx) {
  const ZERO = () => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  });
  /** sessionId → { sessionId, counters, calls, models: Map, lastSeq, seenLen, anchorSeq, model } */
  const records = new Map();
  /** YYYY-MM-DD → { date, tokens, calls }（只保留当月） */
  const dayMap = new Map();
  /** provider/model → { model, tokens, calls } */
  const modelMap = new Map();

  const pad = (n) => String(n).padStart(2, "0");
  const dateKeyOf = (time) => {
    const d = Number.isFinite(time) ? new Date(time) : new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const currentMonthPrefix = () => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-`;
  };

  /** 把一条 usage 累加进 counters，返回这条计入的总 tokens。 */
  const addUsage = (counters, usage) => {
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    let total = input + output + cacheRead + cacheWrite;
    // 部分 provider 只回 totalTokens（或 total 含额外字段），取大者兜底
    const reported = Number(usage.totalTokens);
    if (Number.isFinite(reported) && reported > total) total = reported;
    counters.inputTokens += input;
    counters.outputTokens += output;
    counters.cacheReadTokens += cacheRead;
    counters.cacheWriteTokens += cacheWrite;
    counters.totalTokens += total;
    return total;
  };

  const noteDay = (time, tokens) => {
    const date = dateKeyOf(time);
    const hit = dayMap.get(date) ?? { date, tokens: 0, calls: 0 };
    hit.tokens += tokens;
    hit.calls += 1;
    dayMap.set(date, hit);
  };

  const noteModel = (key, tokens) => {
    const hit = modelMap.get(key) ?? { model: key, tokens: 0, calls: 0 };
    hit.tokens += tokens;
    hit.calls += 1;
    modelMap.set(key, hit);
  };

  const getRecord = (sessionId) => {
    let rec = records.get(sessionId);
    if (!rec) {
      rec = {
        sessionId,
        counters: ZERO(),
        calls: 0,
        models: new Map(),
        lastSeq: Number.NEGATIVE_INFINITY,
        seenLen: 0,
        anchorSeq: undefined,
        lastTurn: 0,
        lastStep: 0,
        model: { provider: "", model: "" },
      };
      records.set(sessionId, rec);
    }
    return rec;
  };

  /** 处理单个事件（调用方已用 seq 去重）。 */
  const handleEvent = (rec, ev) => {
    if (!ev || typeof ev !== "object") return;
    const seq = Number(ev.seq);
    if (Number.isFinite(seq) && seq > rec.lastSeq) rec.lastSeq = seq;
    const data = ev.data && typeof ev.data === "object" ? ev.data : {};
    // turn/step 用于挑"最近的会话"（与 tokenUsageCounter 的 last 字段同构）
    const turn = Number(data.turn);
    const step = Number(data.step);
    if (Number.isFinite(turn)) rec.lastTurn = turn;
    if (Number.isFinite(step)) rec.lastStep = step;

    if (ev.type === "request/header") {
      const cfg = data.header?.config;
      if (typeof cfg?.provider === "string") {
        rec.model = { provider: cfg.provider, model: typeof cfg.model === "string" ? cfg.model : "" };
      }
      return;
    }
    if (ev.type !== "assistant/message") return;
    const usage = data.usage;
    if (!usage || typeof usage !== "object") return;
    const total = addUsage(rec.counters, usage);
    if (total <= 0) return;

    rec.calls += 1;
    const source = data.message?.source ?? {};
    const provider = typeof source.provider === "string" && source.provider ? source.provider : rec.model.provider;
    const model = typeof source.model === "string" && source.model ? source.model : rec.model.model;
    const key = `${provider}/${model}` || "unknown";
    const entry = rec.models.get(key) ?? { provider, model, counters: ZERO(), calls: 0 };
    addUsage(entry.counters, usage);
    entry.calls += 1;
    rec.models.set(key, entry);

    noteDay(ev.time, total);
    noteModel(key, total);
  };

  /**
   * 把一个会话的事件流扫进统计（增量）。
   *
   * 快路径：事件数没变 → 直接返回；尾部追加 → 只处理新增那段。
   * 回退：事件被裁剪/结构变化 → 全量重扫，靠 `seq` 保证不重复计数。
   */
  const ingest = (session) => {
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (!sessionId) return;
    let events;
    try {
      events =
        typeof session.snapshotEvents === "function"
          ? session.snapshotEvents()
          : Array.isArray(session.events)
            ? session.events
            : null;
    } catch {
      return;
    }
    if (!Array.isArray(events)) return;

    const rec = getRecord(sessionId);
    if (events.length === rec.seenLen) return;

    const seqOf = (ev) => Number(ev?.seq);
    const tail =
      events.length > rec.seenLen && seqOf(events[rec.seenLen - 1]) === rec.anchorSeq;
    if (tail) {
      for (let i = rec.seenLen; i < events.length; i += 1) handleEvent(rec, events[i]);
    } else {
      for (const ev of events) {
        const seq = seqOf(ev);
        if (Number.isFinite(seq) && seq <= rec.lastSeq) continue;
        handleEvent(rec, ev);
      }
    }
    rec.seenLen = events.length;
    rec.anchorSeq = seqOf(events[events.length - 1]);
  };

  /** 当前存活的会话列表（sessions 服务不可用时返回空）。 */
  const liveSessions = () => {
    try {
      const svc = ctx.get?.("sessions");
      const list = typeof svc?.list === "function" ? svc.list() : null;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  /** 刷新全部存活会话（`summary` 用）；返回是否有新数据被吃进来。 */
  const refresh = () => {
    for (const session of liveSessions()) ingest(session);
    // 只保留当月的按天数据，避免长驻进程无限增长
    const prefix = currentMonthPrefix();
    for (const key of [...dayMap.keys()]) {
      if (!key.startsWith(prefix)) dayMap.delete(key);
    }
  };

  /** 确保指定会话已统计（`/session` 用）。 */
  const ensure = (sessionId) => {
    if (!sessionId) return;
    if (records.has(sessionId)) {
      // 已有记录：仍补一次增量扫描，吃掉最近的事件
      const session = liveSessions().find((s) => s?.id === sessionId) ?? null;
      if (session) ingest(session);
      return;
    }
    try {
      const svc = ctx.get?.("sessions");
      const session = typeof svc?.get === "function" ? svc.get(sessionId) : null;
      if (session) ingest(session);
    } catch {
      /* 会话服务不可用：保留已统计到的部分 */
    }
  };

  return {
    /** 与 dsh-token-usage-counter.getSession 同构。 */
    getSession(sessionId) {
      if (!sessionId) return null;
      ensure(sessionId);
      const rec = records.get(sessionId);
      if (!rec || rec.calls <= 0) return rec ? shape(rec) : null;
      return shape(rec);
    },
    /** 与 dsh-token-usage-counter.snapshot 同构（只暴露 totals 与 sessions）。 */
    snapshot() {
      refresh();
      const totals = ZERO();
      const sessions = [];
      for (const rec of records.values()) {
        totals.inputTokens += rec.counters.inputTokens;
        totals.outputTokens += rec.counters.outputTokens;
        totals.cacheReadTokens += rec.counters.cacheReadTokens;
        totals.cacheWriteTokens += rec.counters.cacheWriteTokens;
        totals.totalTokens += rec.counters.totalTokens;
        // 只把"知道 provider/model"的会话交出去，供 modelTracker 挑最近一条
        if (rec.model.model) {
          sessions.push({
            last: {
              provider: rec.model.provider,
              model: rec.model.model,
              turn: rec.lastTurn,
              step: rec.lastStep,
            },
          });
        }
      }
      return { totals, sessions };
    },
    /** 当月 / 今日 / 按天 / 按模型的本地统计（供详情页图表与预测）。 */
    usageStats() {
      refresh();
      const prefix = currentMonthPrefix();
      const now = new Date();
      const todayKey = `${prefix}${pad(now.getDate())}`;
      const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
      return {
        monthTokens: days.reduce((sum, d) => sum + d.tokens, 0),
        todayTokens: dayMap.get(todayKey)?.tokens ?? 0,
        today: todayKey,
        days,
        models: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
      };
    },
  };

  /** 内部：把内部记录整形成外部（dsh-token-usage-counter）同构的载荷。 */
  function shape(rec) {
    return {
      sessionId: rec.sessionId,
      counters: { ...rec.counters },
      calls: rec.calls,
      models: [...rec.models.values()].map((m) => ({
        provider: m.provider,
        model: m.model,
        counters: { ...m.counters },
        calls: m.calls,
      })),
    };
  }
}

/**
 * 从会话事件里提取最近一次生效的 provider/model。
 * `request/header` 是唯一权威来源（与 usage-dashboard 的取法一致）。
 * @param {object} session - 会话对象（暴露 snapshotEvents() 或 events）
 * @returns {{provider: string, model: string} | null}
 */
function latestModelFromSession(session) {
  let events;
  try {
    events =
      typeof session?.snapshotEvents === "function"
        ? session.snapshotEvents()
        : Array.isArray(session?.events)
          ? session.events
          : [];
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type !== "request/header") continue;
    const cfg = ev.data?.header?.config;
    if (typeof cfg?.provider === "string" && typeof cfg?.model === "string") {
      return { provider: cfg.provider, model: cfg.model };
    }
  }
  return null;
}

/**
 * 跟踪当前生效的 provider/model。
 *
 * 权威来源按优先级：
 *   1. 实时订阅 session/event 得到的最近 request/header；
 *   2. tokenUsageCounter.snapshot().sessions[].last（落盘计数器）；
 *   3. 内置统计的会话快照 —— 它同样从历史事件里读 `request/header`；
 *   4. 空值（计费类型退化为 provider 命名约定）。
 *
 * 第 3 级是必需的：`dsh-token-usage-counter` 没装时第 2 级恒为空，进程一重启、
 * 本会话又还没发新请求，provider 就取不到 → 计费类型误判成按量、胶囊也跟着
 * 从「剩余百分比」退化成「会话 tokens」。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {() => object | null} getCounter - tokenUsageCounter 访问器
 * @param {() => object | null} [getLocalCounter] - 内置统计访问器
 */
/**
 * 跟踪当前生效的 provider/model。
 *
 * 权威来源按优先级：
 *   1. **平台记录的当前默认模型**（`agent-default-model` 命名空间）——
 *      与 UI 同源：用户一改模型就写，**不需要先发一条消息**。
 *   2. 实时订阅 session/event 得到的最近 request/header（"最近真的用过什么"）。
 *   3. tokenUsageCounter.snapshot().sessions[].last（落盘计数器）。
 *   4. 内置统计的会话快照 —— 同样从历史事件里读 `request/header`。
 *   5. 空值（计费类型退化为 provider 命名约定）。
 *
 * ⚠ 第 1 级是后加的，**别把它挪到后面**：只靠 2~4 级时，用户切换模型但还没发消息，
 * 计费类型会停在旧模型的结论上 —— 实测切到 mimo 后仍显示"按量付费"，
 * 而平台 UI 已经是 mimo（用户反馈过这个问题）。
 * 第 3 级也不能去掉：`dsh-token-usage-counter` 没装时它恒为空，进程一重启、
 * 本会话又还没发新请求，provider 就取不到。
 *
 * @param {object} ctx - 插件上下文（用于订阅会话事件）
 * @param {() => object | undefined} getCounter - 落盘计数器
 * @param {() => object | undefined} getLocalCounter - 内置统计
 * @param {() => ({provider?: string, model?: string} | null)} [getDefaultModel]
 *   - 读取平台「当前默认模型」；缺失时跳过该级
 */
export function createModelTracker(ctx, getCounter, getLocalCounter, getDefaultModel) {
  /** @type {{provider: string, model: string} | null} */
  let tracked = null;

  const note = (session) => {
    const hit = latestModelFromSession(session);
    if (hit) tracked = hit;
  };

  // 只订阅事件通道；ctx.on 在缺少该事件时是安全的空操作
  try {
    ctx.on?.("session/event", (session) => {
      if (session) note(session);
    });
    ctx.on?.("session/created", (session) => {
      if (session) note(session);
    });
  } catch {
    /* 事件通道不可用时仅依赖快照回退 */
  }

  /** 从一份会话快照里挑"最近"的 provider/model。 */
  const pickBest = (sessions) => {
    let best = null;
    for (const s of sessions) {
      const provider = s?.last?.provider;
      const model = s?.last?.model;
      if (typeof provider !== "string" || typeof model !== "string" || !model) continue;
      // datetime 键缺失时用 turn/step 作为"最近"的近似
      const weight = Number(s?.last?.turn ?? 0) * 1e6 + Number(s?.last?.step ?? 0);
      if (!best || weight >= best.weight) best = { provider, model, weight };
    }
    return best;
  };

  /**
   * 当前生效的 provider/model。
   *
   * ⚠ 顺序有语义，别随手调整：
   *   ① 平台「当前默认模型」—— 用户此刻选的是什么（切了就算，不必先发请求）
   *   ② 事件流/计数器 —— 最近一次真的用过什么（切了但没发消息时会滞后）
   * 把 ② 放在 ① 前面就会出现"切成 mimo 却仍报按量付费"的问题。
   *
   * @returns {{provider: string, model: string}}
   */
  const current = () => {
    // ① 当前选中的默认模型（与平台 UI 同源）
    try {
      const def = getDefaultModel?.();
      if (def && (def.provider || def.model)) {
        return { provider: def.provider ?? "", model: def.model ?? "" };
      }
    } catch {
      /* 读不到就继续走事件流 */
    }
    // ② 事件流里最近一次请求用过的
    if (tracked) return tracked;
    // ③ 回退：先看落盘计数器，再看内置统计（两者都拿不到才留空）
    const sources = [getCounter?.(), getLocalCounter?.()];
    for (const source of sources) {
      if (!source || typeof source.snapshot !== "function") continue;
      try {
        const best = pickBest(source.snapshot()?.sessions ?? []);
        if (best) {
          tracked = { provider: best.provider, model: best.model };
          break;
        }
      } catch {
        /* 快照不可用时继续看下一个来源 */
      }
    }
    return tracked ?? { provider: "", model: "" };
  };

  return { note, current };
}

/** provider 是不是小米 MiMo 开放平台通道（如 `mimo`、`xiaomimimo`）。 */
const isMiMoProvider = (provider) => typeof provider === "string" && provider.length > 0 && /mimo/i.test(provider);

/**
 * **按 API 地址**判定计费类型 —— 最直接、最可靠的信号。
 *
 * 小米两条通道的 baseURL 根本不一样（pi-ai 官方目录 `providers/*.json`）：
 *
 *   按量计费    `xiaomi`                → https://api.xiaomimimo.com/v1
 *   Token Plan  `xiaomi-token-plan-cn`  → https://token-plan-cn.xiaomimimo.com/v1
 *   Token Plan  `xiaomi-token-plan-sgp` → https://token-plan-sgp.xiaomimimo.com/v1
 *   Token Plan  `xiaomi-token-plan-ams` → https://token-plan-ams.xiaomimimo.com/v1
 *
 * 所以读 provider 的 `baseURL` 就能分辨，不必依赖官方接口的套餐状态
 * （也不受 provider 显示名叫什么影响 —— 本机这条就叫 `mimo`）。
 *
 * @param {string} baseURL - provider 配置的 API 地址
 * @returns {"token-plan"|"payg"|null} null = 地址看不出来（没读到 / 自建网关）
 */
export function billingTypeFromBaseURL(baseURL) {
  const url = typeof baseURL === "string" ? baseURL.trim() : "";
  if (!url) return null;
  // Token Plan 网关 host 里带 token-plan-<region>
  if (/token-plan/i.test(url)) return "token-plan";
  // 小米官方按量计费网关 api.xiaomimimo.com（其余 xiaomimimo.com 子域也归按量）
  if (/xiaomimimo\.com/i.test(url)) return "payg";
  return null;
}

/**
 * 判定计费类型：显式覆盖 > API 地址 > provider 名 > 官方套餐状态。
 *
 * 优先级与规则：
 *   1. `billingTypeOverrides`（`provider/model` 或 `provider`）—— 用户说了算；
 *   2. **provider 的 API 地址**（`billingTypeFromBaseURL`）：
 *      `token-plan-*.xiaomimimo.com` → 套餐；`api.xiaomimimo.com` → 按量；
 *   3. provider 名含 `token-plan`（如 `xiaomi-token-plan-cn`）→ 套餐；
 *   4. provider 叫 `mimo`（小米通道）但地址没读到 → 用官方 `tokenPlan/detail`
 *      反证：套餐已过期（`expired`）/ 官方明确「无订阅」（`none`）→ 按量，
 *      其余（`active` / `unknown`，即没配 Cookie、接口失败）→ 套餐；
 *   5. 其余 provider → 按量计费（pay-as-you-go）。
 *
 * 早期版本只认 `token-plan` 字面量，于是 provider `mimo` 恒被判成按量，
 * 胶囊因此显示「会话 tokens」而不是套餐剩余百分比。
 *
 * @param {object} mimo - 配置（读 billingTypeOverrides）
 * @param {string} provider
 * @param {string} model
 * @param {"active"|"expired"|"none"|"unknown"} [planStatus] - 官方套餐状态
 * @param {string} [baseURL] - 该 provider 的 API 地址
 * @returns {"token-plan"|"payg"}
 */
export function billingTypeFor(mimo, provider, model, planStatus = "unknown", baseURL = "") {
  const overrides = mimo?.billingTypeOverrides ?? {};
  const hit = overrides[`${provider}/${model}`] ?? overrides[provider];
  if (hit === "token-plan" || hit === "payg") return hit;

  // 2) 地址说了算
  const byUrl = billingTypeFromBaseURL(baseURL);
  if (byUrl) return byUrl;

  // 3) provider 名
  if (/token-plan/i.test(provider)) return "token-plan";

  // 4) 小米通道 + 地址未知 → 用官方套餐状态兜底
  if (isMiMoProvider(provider)) {
    if (planStatus === "expired" || planStatus === "none") return "payg";
    return "token-plan";
  }

  // 5) 非小米通道、也没过请求（provider 为空）时保持按量这个保守默认，
  //    调用方会用 `providerKnown` 决定是否展示该结论。
  return "payg";
}

/**
 * 汇总 MiMo 状态（胶囊与详情页共用）。
 * @param {object} deps - { ctx, cfg, getCounter }
 * @param {AbortSignal} [signal]
 */
async function buildSummary(deps, signal) {
  const { ctx, cfg, getCounter } = deps;
  // 用户层设置（设置页保存）优先于 patch 层 config
  const mimo = deps.currentMimo?.() ?? cfg.mimo ?? DEFAULT_CONFIG.mimo;
  const { cookie, source: cookieSource } = await resolveCookie(ctx, mimo);
  const apiBase = (process.env.MIMO_API_URL || DEFAULT_MIMO_API).replace(/\/+$/, "");

  const result = {
    official: false,
    officialError: "",
    cookieSource,
    plan: null,
    planUsage: null,
    // 官方套餐状态（active/expired/none/unknown），供计费类型判定用
    planStatus: "unknown",
    balance: null,
    local: null,
    billingType: "token-plan",
    providerBaseURL: "",
    model: "",
    provider: "",
    sessionTokens: 0,
    priceSource: "fallback",
    price: mimo.pricing?.fallbackPrice ?? DEFAULT_CONFIG.mimo.pricing.fallbackPrice,
    updatedAt: Date.now(),
  };

  // 1) 官方三连
  if (cookie) {
    const [okB, rawB] = await fetchJson(`${apiBase}/balance`, cookie, signal);
    const [okD, rawD] = await fetchJson(`${apiBase}/tokenPlan/detail`, cookie, signal);
    const [okU, rawU] = await fetchJson(`${apiBase}/tokenPlan/usage`, cookie, signal);
    const balance = okB ? parseBalance(rawB) : null;
    const plan = okD ? parseTokenPlanDetail(rawD) : null;
    const usage = okU ? parseTokenPlanUsage(rawU) : null;
    // 套餐状态单独记：它决定 provider `mimo` 判套餐还是按量
    result.planStatus = planStatusOf(okD, rawD, plan);

    if (balance || usage) {
      result.official = true;
      result.balance = balance;
      result.plan = plan;
      result.planUsage = usage;
    } else {
      const errs = [];
      if (!okB) errs.push(`balance: ${rawB}`);
      if (!okD) errs.push(`detail: ${rawD}`);
      if (!okU) errs.push(`usage: ${rawU}`);
      result.officialError = errs.join("; ") || "empty responses";
    }
  } else {
    result.officialError = "未配置 Cookie（config.mimo.cookie / 凭据 MIMO_CONSOLE_COOKIE）";
  }

  // 2) 本地统计（始终采集，供详情页统计与预测）
  //
  // 取数顺序：落盘目录（完整历史）> 进程内会话统计（回退）> 无。
  // `token-usage/` 由 dsh-token-usage-counter 写入；它没装时目录根本不存在，
  // 早期版本直接把 ENOENT 当错误显示，且本月/今日 tokens 永远是 0。
  const dshHome = process.env.DSH_HOME ?? "";
  const dirStats = dshHome ? await aggregateLocalUsage(dshHome) : null;
  const memStats = deps.localCounter?.usageStats?.() ?? null;
  if (dirStats && dirStats.ok && dirStats.days.length > 0) {
    result.local = dirStats;
  } else if (memStats) {
    const why =
      dirStats && !dirStats.ok && dirStats.error
        ? `本地目录不可用（${dirStats.error}）`
        : dirStats?.note || "本地目录暂无当月记录";
    result.local = {
      ...memStats,
      ok: true,
      source: "session-events",
      error: "",
      missing: true,
      dir: dirStats?.dir ?? "",
      note: `${why}；已改用进程内会话事件统计（仅覆盖插件加载后仍存活的会话，重启归零）`,
      updatedAt: Date.now(),
    };
  } else {
    result.local = dirStats;
  }
  if (!result.official && result.local?.ok) {
    const limit = Number(mimo.planTotalTokens) || 0;
    const used = result.local.monthTokens;
    const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    result.planUsage = {
      percent: Number(percent.toFixed(2)),
      // 本地估算的单位是 tokens（不是官方套餐的 Credits），显式区分避免误读
      unit: "tokens",
      items: [
        {
          name: "local_estimate",
          label: "本地估算（本月已用）",
          used,
          limit,
          percent: Number(percent.toFixed(2)),
        },
      ],
    };
    result.plan = { planCode: "local-estimate", periodEnd: "", expired: false };
  }

  // 3) 当前 provider/model
  const tracker = deps.modelTracker;
  const hit = tracker ? tracker.current() : { provider: "", model: "" };
  result.provider = hit.provider;
  result.model = hit.model;
  const counter = getCounter();
  if (counter && typeof counter.snapshot === "function") {
    try {
      result.sessionTokens = counter.snapshot()?.totals?.totalTokens ?? 0;
    } catch {
      /* 快照不可用时保持 0 */
    }
  }
  // dsh-token-usage-counter 缺席（或它没有数据）时用内置统计兜底，
  // 否则「会话 token 使用量」会恒为 0
  if (!result.sessionTokens && deps.localCounter) {
    try {
      result.sessionTokens = deps.localCounter.snapshot()?.totals?.totalTokens ?? 0;
    } catch {
      /* 内置统计不可用时保持 0 */
    }
  }

  // 4) 计费类型与单价
  // 首要信号是 provider 的 API 地址（小米按量/套餐两条通道 baseURL 不同）
  result.providerBaseURL = deps.providerBaseURL?.(result.provider) ?? "";
  result.billingType = billingTypeFor(
    mimo,
    result.provider,
    result.model,
    result.planStatus,
    result.providerBaseURL,
  );
  // provider 未知时（本会话还没发过请求）计费类型只是占位，不应作为结论展示
  result.providerKnown = Boolean(result.provider);
  const pricing = mimo.pricing ?? {};
  const exact = `${result.provider}/${result.model}`;
  const configured = pricing[exact] ?? pricing[result.provider];
  if (configured) {
    result.price = configured;
    result.priceSource = pricing[exact] ? exact : result.provider;
  } else {
    result.price = pricing.fallbackPrice ?? DEFAULT_CONFIG.mimo.pricing.fallbackPrice;
    result.priceSource = "fallback";
  }

  // UI 偏好透传（胶囊位置 / 工具栏换行），供客户端渲染决策
  result.ui = {
    pillPosition: mimo.pillPosition ?? "header",
    wrapToolbar: mimo.wrapToolbar !== false,
  };

  // 浏览器半边的自诊断回传（脚本加载 → 工厂 → apply），诊断"装了没生效"
  result.client = deps.lastClientPing ?? null;
  result.clientLog = deps.clientLog ?? [];

  result.updatedAt = Date.now();
  return result;
}

/** 写 JSON 响应。 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 同源检查。
 *
 * 浏览器可能经 fnOS 网关访问（Host 为 NAS 地址:端口），因此不能只放行 loopback。
 * 判定顺序：
 *   1. 显式跨站（Sec-Fetch-Site: cross-site）→ 拒绝
 *   2. 有 Origin 且与 Host 同源 → 放行（覆盖网关转发的同源请求）
 *   3. 无 Origin（同源 GET / 服务端调用）→ 放行
 *   4. 其余 → 拒绝
 */
/**
 * 判断请求是否可信。
 *
 * 背景：经 fnOS 的 nginx + gateway 二级转发时，`Host` 会被改写成 `localhost`，
 * 而浏览器 `Origin` 是实际访问域名（如 `https://sublime.fnos.net`），
 * 两者永不相等。所以**不能**用 `Origin.host === Host` 作为唯一判据 ——
 * 那会让反代场景一律 403（设置页保存失败）。
 *
 * 处置原则：**挡跨站，不挡反代**。真正的主力判据是
 * `Sec-Fetch-Site`：现代浏览器强制附带、页面 JS 无法伪造；
 * 只有它缺席（老浏览器 / 非浏览器客户端）时才退回 Host 比对。
 *
 *   1. `Sec-Fetch-Site: cross-site` → 拒绝（跨站最强信号）
 *   2. `Sec-Fetch-Site: same-origin` / `same-site` → 放行（浏览器已确认同源，
 *      Host 被反代改写也不影响这个结论）
 *   3. 无 `Origin` → 放行（同源 GET / 服务端调用不带 Origin）
 *   4. `Origin` 是内网地址（回环、10./192.168./172.16-31、.local、.fnos.net）
 *      → 放行（同源部署；身份由 DSH 的 dsh-auth 会话 Cookie 决定）
 *   5. `Origin.host` 命中 `Host` / `X-Forwarded-Host` → 放行
 *   6. 其余 → 拒绝
 *
 * `/api/*` 前缀另有 DSH 核心的严格 fence；本插件刻意避开该前缀
 * （见 ROUTE_PREFIX 注释），因此这里保留一层自有校验。
 * 插件响应不含密钥（Cookie 永不回传浏览器），风险面有限。
 */
function isTrusted(req) {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") {
    const s = site.trim().toLowerCase();
    if (s === "cross-site") return false;
    if (s === "same-origin" || s === "same-site" || s === "none") return true;
  }

  const origin = req.headers.origin;
  if (!origin) return true;

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (!originUrl.host) return false;

  const isLoopback = (h) => h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h);
  const isPrivate = (h) =>
    isLoopback(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /\.local$/.test(h) ||
    /\.fnos\.net$/.test(h);

  // 浏览器 Origin 指向内网/本机 → 同源部署，放行
  if (isPrivate(originUrl.hostname)) return true;

  const candidates = [
    req.headers.host,
    ...(req.headers["x-forwarded-host"] ?? "").split(","),
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  // Origin 与 Host / X-Forwarded-Host 对得上 → 放行
  return candidates.includes(originUrl.host);
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - patch 层注入的 config
 */
export function apply(ctx, config) {
  const cfg = mergeConfig(DEFAULT_CONFIG, config ?? {});

  // tokenUsageCounter 是可选兄弟服务：装配后持有引用，未装配则退化
  let counter = ctx.get?.("tokenUsageCounter") ?? null;
  const getCounter = () => {
    if (counter) return counter;
    counter = ctx.get?.("tokenUsageCounter") ?? null;
    return counter;
  };

  const deps = { ctx, cfg, getCounter };
  // 浏览器半边的自诊断回传（POST /ping 写入），随 /summary 一起吐出：
  // lastClientPing = 最近一次；clientLog = 最近 20 次（带页面路径与时序）
  deps.lastClientPing = null;
  deps.clientLog = [];

  // 内置会话/本日本月用量统计：dsh-token-usage-counter 装配时以它为准，
  // 未装配时（或它没有该会话数据）用本插件从 session 事件里自建的统计。
  // 没有它，`/dsh-mimo-usage/session` 会恒返回 null → 会话用量恒为 0。
  deps.localCounter = createLocalUsageCounter(ctx);

  // provider 的 API 地址 —— 从 `llm-pi-ai` 命名空间的 providers.<id>.baseURL 读。
  // 小米按量与套餐两条通道的 baseURL 不同（api.xiaomimimo.com vs token-plan-cn.…），
  // 所以地址本身就是计费类型最直接的判定依据，不必依赖官方套餐状态。
  let settingsService = null;
  deps.providerBaseURL = (provider) => {
    if (!provider || !settingsService || typeof settingsService.get !== "function") return "";
    try {
      const doc = settingsService.get("llm-pi-ai");
      const url = doc?.providers?.[provider]?.baseURL;
      return typeof url === "string" ? url : "";
    } catch {
      return "";
    }
  };

  /**
   * 平台记录的「当前默认模型」（`agent-default-model` 命名空间）。
   *
   * ⚠ 为什么必须读它：`modelTracker` 只从 `request/header` 事件里取模型 ——
   * 也就是**发过请求**才会更新。用户在 UI 里把模型切到 MiMo 但还没发消息时，
   * tracker 仍停在旧值（实测：切成 mimo 后计费类型依旧显示"按量付费"，
   * 而平台自己的模型选择器已经显示 mimo）。这是用户反馈的核心问题。
   *
   * `agent-default-model` 是平台（`dsh-agent-default-model` 插件）记录
   * 「当前选中模型」的权威位置，切模型时立即写入，与 UI 同源。
   *
   * @returns {{provider: string, model: string} | null}
   */
  const readDefaultModel = () => {
    if (!settingsService || typeof settingsService.get !== "function") return null;
    try {
      const doc = settingsService.get("agent-default-model");
      const provider = typeof doc?.provider === "string" ? doc.provider : "";
      const model = typeof doc?.model === "string" ? doc.model : "";
      if (!provider && !model) return null;
      return { provider, model };
    } catch {
      return null;
    }
  };
  deps.readDefaultModel = readDefaultModel;

  // 跟踪当前生效的 provider/model。
  // 优先级：**当前选中的默认模型**（与 UI 同源，切了就算）→ request/header 事件
  //        → 落盘计数器快照 → 内置统计快照 → 空值。
  // 把「默认模型」放第一位，是因为它才是"用户此刻选的是什么"；
  // 事件流的语义是"最近一次真的用过什么"，切了模型但没发消息时会滞后。
  deps.modelTracker = createModelTracker(ctx, getCounter, () => deps.localCounter, readDefaultModel);

  // ---- 设置持久化（settings.yaml 的 dsh-mimo-usage 命名空间）----
  // 用户在「MiMo 用量」页填写的 Cookie / 套餐总量 / 胶囊位置等存这里，
  // 优先级高于 patch 层 config（config 作为组成基线）。
  let userSettings = null;
  ctx.inject(["settings"], (settingsCtx) => {
    // 先抓住 settings 服务：除了注册本插件命名空间，还要用它读
    // `llm-pi-ai` 的 providers.<id>.baseURL（判定计费类型用）。
    settingsService = settingsCtx?.settings ?? null;
    try {
      // 真 schemastery 才注册：手写 schema 缺 toJSON 会让 describe() 把整个
      // 设置页一起拖垮（见 buildMimoSettingsSchema 的说明）。
      const schema = buildMimoSettingsSchema(settingsCtx);
      if (!schema) {
        ctx.logger?.warn?.(
          "[dsh-mimo-usage] 拿不到 @deepseek-ai/schemastery，跳过设置命名空间注册：" +
            "本插件配置在设置页里会是只读（patch 层 config 仍生效），其它插件的设置页不受影响",
        );
        return;
      }
      const scope = settingsCtx.settings.register(SETTINGS_NS, schema, { base: config ?? {} });
      userSettings = scope;
      scope.watch(() => {
        cached = null;
        cachedAt = 0;
      });
    } catch (error) {
      ctx.logger?.warn?.("[dsh-mimo-usage] settings 注册失败：%s", error instanceof Error ? error.message : String(error));
    }
  });
  /** 用户层设置合并后的 mimo 配置（用户层 > patch config）。 */
  const currentMimo = () => {
    const fromUser = userSettings?.get?.() ?? {};
    const merged = mergeConfig(DEFAULT_CONFIG, config ?? {});
    const userMimo = fromUser.mimo ?? {};
    const out = mergeConfig(merged, { mimo: userMimo });
    return out.mimo ?? DEFAULT_CONFIG.mimo;
  };
  deps.currentMimo = currentMimo;

  // 60 秒结果缓存；refresh=1 绕过
  let cached = null;
  let cachedAt = 0;
  let inflight = null;
  const getSummary = (signal) => {
    if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return Promise.resolve(cached);
    if (inflight) return inflight;
    inflight = buildSummary(deps, signal)
      .then((value) => {
        cached = value;
        cachedAt = Date.now();
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  // ---- web 路由：/api/dsh-mimo-usage/*（软依赖 webServer）----
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    if (!webServer || typeof webServer.register !== "function") return;
    webCtx.effect(
      () =>
        webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            if (!isTrusted(req)) {
              writeJson(res, 403, { ok: false, error: "forbidden" });
              return;
            }
            const url = new URL(req.url ?? "/", "http://dsh.internal");

            // —— 浏览器半边自诊断回传（POST /ping）——
            // "装了没生效"这类问题只发生在浏览器里，服务端看不到；让 client
            // 在「脚本加载 → 工厂调用 → apply 执行」三个节点各报一次到，
            // 就能从 /summary 的 client 字段直接读出它卡在哪一步。
            if (url.pathname === ROUTE_PREFIX + "/ping") {
              if (req.method !== "POST" && req.method !== "PUT") {
                writeJson(res, 405, { ok: false, error: "method not allowed" });
                return;
              }
              const body = await readJsonBody(req);
              if (!body || typeof body !== "object") {
                writeJson(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
                return;
              }
              const entry = {
                stage: typeof body.stage === "string" ? body.stage : "",
                entryName: typeof body.entryName === "string" ? body.entryName : "",
                registered: Array.isArray(body.registered) ? body.registered.slice(0, 20) : [],
                error: typeof body.error === "string" ? body.error.slice(0, 500) : "",
                path: typeof body.path === "string" ? body.path.slice(0, 200) : "",
                hash: typeof body.hash === "string" ? body.hash.slice(0, 200) : "",
                at: Date.now(),
              };
              deps.lastClientPing = entry;
              // 留最近 20 条：多个标签页 / 多次刷新的时序都在这里
              deps.clientLog.push(entry);
              if (deps.clientLog.length > 20) deps.clientLog.shift();
              writeJson(res, 200, { ok: true, data: { received: true } });
              return;
            }

            try {
              // —— 设置读写（POST，供「MiMo 用量」页内的配置表单）——
              if (url.pathname === ROUTE_PREFIX + "/settings") {
                if (req.method === "GET") {
                  const m = currentMimo();
                  // 用与真实取值同一套解析（config → 凭据 → 环境变量），
                  // 否则凭据里配了 Cookie 也会被误报成"未配置"。
                  const resolved = await resolveCookie(ctx, m);
                  writeJson(res, 200, {
                    ok: true,
                    data: {
                      // Cookie 不回传明文，只回传是否已配置与来源，避免泄漏到浏览器
                      cookieConfigured: Boolean(resolved.cookie),
                      cookieSource: resolved.source,
                      planTotalTokens: m.planTotalTokens ?? 0,
                      pillPosition: m.pillPosition ?? "header",
                      wrapToolbar: m.wrapToolbar !== false,
                      billingTypeOverrides: m.billingTypeOverrides ?? {},
                      pricing: m.pricing ?? {},
                      writable: Boolean(userSettings),
                    },
                  });
                  return;
                }
                if (req.method === "POST" || req.method === "PUT") {
                  if (!userSettings) {
                    writeJson(res, 503, { ok: false, error: "设置服务不可用（settings 未装配）" });
                    return;
                  }
                  const body = await readJsonBody(req);
                  if (!body || typeof body !== "object") {
                    writeJson(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
                    return;
                  }
                  const patch = {};
                  if (typeof body.cookie === "string") patch.cookie = body.cookie.trim();
                  if (Number.isFinite(Number(body.planTotalTokens))) patch.planTotalTokens = Number(body.planTotalTokens);
                  if (body.pillPosition === "header" || body.pillPosition === "toolbar" || body.pillPosition === "above" || body.pillPosition === "hidden") {
                    patch.pillPosition = body.pillPosition;
                  }
                  if (typeof body.wrapToolbar === "boolean") patch.wrapToolbar = body.wrapToolbar;
                  await userSettings.update({ mimo: patch });
                  cached = null;
                  cachedAt = 0;
                  writeJson(res, 200, { ok: true, data: { saved: Object.keys(patch) } });
                  return;
                }
                writeJson(res, 405, { ok: false, error: "method not allowed" });
                return;
              }

              if (req.method !== "GET") {
                writeJson(res, 405, { ok: false, error: "method not allowed" });
                return;
              }
              if (url.pathname === ROUTE_PREFIX + "/summary") {
                const force = url.searchParams.get("refresh") === "1";
                const payload = force ? await buildSummary(deps) : await getSummary();
                // client/clientLog 实时合并：浏览器半边的回传不该跟着 summary 缓存过期
                writeJson(res, 200, {
                  ok: true,
                  data: {
                    ...payload,
                    client: deps.lastClientPing ?? null,
                    clientLog: deps.clientLog ?? [],
                  },
                });
                return;
              }
              if (url.pathname === ROUTE_PREFIX + "/session") {
                const id = url.searchParams.get("id") ?? "";
                writeJson(res, 200, { ok: true, data: sessionUsagePayload(getCounter(), deps.localCounter, id) });
                return;
              }
              writeJson(res, 404, { ok: false, error: "not found" });
            } catch (error) {
              writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      "dsh-mimo-usage: /api routes",
    );
  });

  // ---- 斜杠命令：/mimo ----
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "mimo",
      description: "查看 MiMo 额度（Token Plan 套餐剩余 / 按量计费用量）",
      handler: async ({ signal }) => {
        try {
          return { kind: "success", text: formatSummaryText(await getSummary(signal)) };
        } catch (error) {
          return { kind: "error", text: `查询失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
    });
  });

  // ---- 工具：mimo_usage ----
  ctx.inject(["tools"], (toolCtx) => {
    toolCtx.tools.register({
      name: "mimo_usage",
      description:
        '查询 MiMo 额度与用量。query 取值：balance（套餐剩余与余额）、usage（用量统计）、both（两者）。当用户问"额度/还剩多少/套餐/用量"时使用。',
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            enum: ["balance", "usage", "both"],
            description: "balance=套餐剩余与余额；usage=用量统计；both=两者都要",
          },
        },
        required: ["query"],
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      async execute(args, exec) {
        try {
          return formatSummaryText(await getSummary(exec?.signal), args?.query ?? "both");
        } catch (error) {
          return `查询失败：${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  });
}

/**
 * 会话级 token 用量（按 provider/model 拆分）。
 *
 * 取数顺序：`dsh-token-usage-counter` 有该会话的数据就用它；
 * 否则退回内置统计（本插件从 session 事件自建）。
 * 只认 `dsh-token-usage-counter` 的老实现会在它缺席时恒返回 null ——
 * 客户端拿不到 session，「会话 token 使用量」就恒为 0。
 *
 * @param {object|null} counter - ctx.tokenUsageCounter（可缺）
 * @param {object|null} local - 内置统计（可缺）
 * @param {string} sessionId
 */
export function sessionUsagePayload(counter, local, sessionId) {
  if (!sessionId) return null;
  const read = (svc) => {
    if (!svc || typeof svc.getSession !== "function") return null;
    try {
      return svc.getSession(sessionId) ?? null;
    } catch {
      return null;
    }
  };
  const real = read(counter);
  const fallback = read(local);
  const rec = real && Number(real.calls ?? 0) > 0 ? real : (fallback ?? real);
  if (!rec) return null;
  const c = rec.counters ?? {};
  return {
    sessionId,
    totalTokens: c.totalTokens ?? 0,
    inputTokens: c.inputTokens ?? 0,
    outputTokens: c.outputTokens ?? 0,
    cacheReadTokens: c.cacheReadTokens ?? 0,
    cacheWriteTokens: c.cacheWriteTokens ?? 0,
    calls: rec.calls ?? 0,
    models: (rec.models ?? []).map((m) => ({
      provider: m.provider,
      model: m.model,
      totalTokens: m.counters?.totalTokens ?? 0,
      calls: m.calls ?? 0,
    })),
    // 让客户端能区分数据来自落盘计数器还是进程内统计
    source: rec === fallback ? "session-events" : "token-usage-counter",
  };
}

/** 把 summary 渲染成文本（命令与工具共用）。 */
function formatSummaryText(s, query = "both") {
  const lines = [];
  const wantBalance = query === "balance" || query === "both";
  const wantUsage = query === "usage" || query === "both";

  if (wantBalance) {
    if (s.official && s.planUsage) {
      lines.push("数据来源：小米 MiMo 官方接口");
      if (s.plan) {
        lines.push(
          `套餐：${s.plan.planCode || "未知"}${s.plan.expired ? "（已过期）" : ""}${s.plan.periodEnd ? `，周期至 ${s.plan.periodEnd}` : ""}`,
        );
      }
      lines.push(`本月已用 ${s.planUsage.percent}%，剩余 ${Math.max(0, 100 - s.planUsage.percent).toFixed(2)}%`);
      const unit = s.planUsage.unit ?? "Credits";
      for (const it of s.planUsage.items) {
        lines.push(`  ${it.label ?? it.name}：${it.used.toLocaleString()} / ${it.limit.toLocaleString()} ${unit}（${it.percent}%）`);
      }
    } else if (s.planUsage) {
      const it = s.planUsage.items[0];
      lines.push(`数据来源：本地估算（官方接口不可用：${s.officialError}）`);
      lines.push(
        `本月已用 ${s.planUsage.percent}%，剩余 ${Math.max(0, 100 - s.planUsage.percent).toFixed(2)}%（${it.used.toLocaleString()} / ${it.limit.toLocaleString()} ${s.planUsage.unit ?? "tokens"}）`,
      );
    } else {
      lines.push(`额度不可用：${s.officialError || "无数据"}`);
    }
    if (s.balance) {
      lines.push(`余额：${s.balance.balance} ${s.balance.currency}（现金 ${s.balance.cashBalance}，赠金 ${s.balance.giftBalance}）`);
    }
  }

  if (wantUsage) {
    lines.push(`计费类型：${s.billingType === "token-plan" ? "Token Plan 套餐" : "按量计费（pay-as-you-go）"}`);
    if (s.model) lines.push(`当前模型：${s.provider}/${s.model}`);
    if (s.providerBaseURL) {
      const byUrl = billingTypeFromBaseURL(s.providerBaseURL);
      lines.push(`API 地址：${s.providerBaseURL}${byUrl ? `（按地址判定：${byUrl === "token-plan" ? "Token Plan" : "按量"}）` : ""}`);
    }
    if (s.local?.ok) {
      const src = s.local.source === "session-events" ? "（进程内会话统计，重启归零）" : "（token-usage 目录）";
      lines.push(`今日 tokens：${s.local.todayTokens.toLocaleString()} ${src}`);
      lines.push(`本月 tokens：${s.local.monthTokens.toLocaleString()}`);
      if (s.local.note) lines.push(`统计说明：${s.local.note}`);
    } else if (s.local) {
      lines.push(`本地统计不可用：${s.local.error || s.local.dir}`);
    }
    lines.push(`会话 tokens（累计）：${Number(s.sessionTokens ?? 0).toLocaleString()}`);
  }

  return lines.join("\n") || "暂无数据";
}

export default apply;
