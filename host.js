import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// @ts-check
/**
 * dsh-mimo-extension — DeepSeek Harness 宿主插件
 *
 * 功能：
 *   /mimo          查看 MiMo 额度（套餐剩余 / 本地估算）
 *   工具 mimo_usage —— 让模型自己查询额度与用量
 *   /api/dsh-mimo-extension/*  供浏览器胶囊与详情页轮询的 JSON 路由
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
import { join, delimiter as pathDelimiter } from "node:path";
import { createRequire } from "node:module";

/** 活动 profile 的 patch 文件（PowerHarness 部署单 profile=web；可用 DSH_PROFILE 覆盖）。 */


export const name = "mimo-extension";

/**
 * 强依赖：命令与工具注册表。
 * webServer 走 ctx.inject 软依赖，缺失时插件仍能加载（headless 组合）。
 */
// configEditor：0.2 读**别人的**命名空间（llm-pi-ai / agent-default-model）的唯一
// 正路 —— settings.get(ns) 只认已注册 ns 且 0.2 的 SettingsForms 根本没有 get。
export const inject = ["commands", "tools", "settings", "configEditor"];

const DEFAULT_MIMO_API = "https://platform.xiaomimimo.com/api/v1";
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60_000;

/** settings.yaml 里的配置命名空间。 */
// ⚠ 必须与本插件 bundle patch（node_modules/dsh-mimo-extension/cordis.patch.yml）
// 里那条 `- id:` **完全一致**：DSH 的 configEditor.entries() 以 bundle patch 的
// insert id 作为 loader 条目的 options.id，而 settings.write(ns) 正是按
// `row.options.id === ns` 查找条目的。profile patch 里的同名条目只是**覆盖 config**，
// 不会改变 options.id。
// 历史：bundle patch 用的是短名 `mimo-extension`，而这里写的是全名
// `dsh-mimo-extension` → 永远匹配不上 → 保存报 `No configurable plugin entry`。
// 对照：dsh-ui-cyanmod 三处同名，所以它一直正常。
// 0.2 实测（--dump-config）：loader 条目的 options.id 是**全名** `dsh-mimo-extension`
// （cordis.patch.yml 的 `- id: dsh-mimo-extension`），而 `settings.write(ns)` /
// `register(ns)` 按 `row.options.id === ns` 查条目 —— 短名 `mimo-extension` 查不到，
// 保存报 `No configurable plugin entry`。用户配置也存在全名段的 `config.mimo`。
// ⚠ 别再改回短名：10-01 曾改成短名导致配置保存全挂（plugin-settings-check 30/32 抓到）。
const SETTINGS_NS = "dsh-mimo-extension";
// 迁移来源之一。⚠ 10-02 起它与 SETTINGS_NS **同值**（SETTINGS_NS 已改回全名，
// 见上方说明）—— 保留它是因为迁移 for 循环按 [本常量, LEGACY_SETTINGS_NS] 遍历，
// 且改名史里"全名"曾是旧名。**自读无害**：迁移函数先判当前段有无内容，
// 有则直接 skip（走不到 for）；当前段为空时本段必然也为空 → 不会被选中。
const LEGACY_SETTINGS_NS_FULL = "dsh-mimo-extension";
/**
 * 重命名前的设置命名空间。
 *
 * 插件原名 `dsh-mimo-extension`（2026-09-27 改名为 `dsh-mimo-extension`）。
 * 老用户的配置（**含 Cookie**）存在旧段落里，所以启动时要把它**迁移**到新段落 ——
 * 直接换名会让用户凭空丢配置，而且旧段落会变成没人管的孤儿。
 *
 * ⚠ 迁移是**单向、幂等**的：只在"新段为空 + 旧段有内容"时搬一次，
 * 之后旧段不再读取（但**不删除** —— 留作回滚依据，用户可手动清理）。
 */
const LEGACY_SETTINGS_NS = "dsh-mimo-usage";
// 上轮曾把配置写到 `dsh-mimo-extension` 段；改名后要把它也迁过来，否则用户配置丢。

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
const ROUTE_PREFIX = "/dsh-mimo-extension";

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
/**
 * 解包 schemastery `.volatile()` 字段的**引用对象**。
 *
 * 🔴 10-01 真 bug（0.2 引入 volatile 之后暴露）：
 * `.volatile()` 字段解析出来的不是标量，而是引用对象 `{ get() }`（createVolatile 形态，
 * 官方判定 `isVolatile` = 对象且带 `write`）。它的危害是**静默**的：
 *   - `JSON.stringify(ref)` → `{}`（看上去像空对象，实为引用）
 *   - `ref ?? "header"` → **不回落**（对象是 truthy）→ `result.ui.pillPosition` 变成 `{}`
 *     → 浏览器拿 `{}` 查座位表 → `PILL_SEATS[{}]` = undefined → 胶囊不注册/位置乱
 *
 * `mimoSettingsSchema` 的读写器已 unwrap，但它只覆盖 normalize 路径；
 * **`result.ui` 那两处透传读的是 `currentMimo()`（settings 服务解析值）**，绕过了 normalize，
 * 所以必须在这里再兜一层。姊妹项目 dsh-usage-cyanmod 用同样的 unwrap 范式。
 *
 * @param {unknown} v 任意值（可能是引用对象/标量/undefined）。
 * @returns {unknown} 解引用后的标量；不是引用对象时原样返回。
 */
export function derefVolatile(v) {
  if (v === null || typeof v !== "object") return v;
  if (typeof v.get !== "function") return v;
  try {
    return v.get();
  } catch {
    return v;
  }
}

/** 胶囊位置的合法取值（与 mimoSettingsSchema 的 positions 一致）。 */
const PILL_POSITIONS = ["header", "toolbar", "above", "hidden"];

/**
 * 读一个 volatile 字符串偏好并做白名单回落。
 *
 * ⚠ 不能写成 `mimo.pillPosition ?? "header"` —— 引用对象是 truthy，`??` 不生效。
 *
 * @param {unknown} v 原始值（可能是引用对象）。
 * @param {string[]} allowed 合法取值。
 * @param {string} fallback 兜底值。
 * @returns {string} 一定落在 allowed 里的字符串。
 */
export function pickVolatile(v, allowed, fallback) {
  const x = derefVolatile(v);
  return typeof x === "string" && allowed.includes(x) ? x : fallback;
}

function mimoSettingsSchema(input) {
  const src = input && typeof input === "object" ? input : {};
  const mimo = src.mimo && typeof src.mimo === "object" ? src.mimo : {};
  // ⚠ schemastery `.volatile()` 字段解析出来的是**引用对象** `{ get(), [write] }`
  // （createVolatile 的形态，官方判定 `isVolatile` = 对象且带 `write`）——
  // 直接当字符串/布尔用会**全部落回默认值**（用户改了设置却「不生效」），
  // 而经 JSON.stringify / 打印时会显示成 `{}`（看上去像空对象，实为引用）。
  // 官方读法见 dsh-agent-default-model：`this.config.provider.get()`。
  // 姊妹项目 dsh-usage-cyanmod 已用同一范式修复（它的 check.mjs 有对应断言）。
  const unwrap = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (typeof v.get !== "function") return v;
    // 普通配置对象也可能恰好有 get 键（用户数据），只认「引用协议」：
    // 引用对象冻结且只有 get/write 自有键。
    const keys = Object.keys(v);
    if (keys.length > 0 && keys.every((k) => k === "get" || typeof k === "symbol")) {
      try {
        return v.get();
      } catch {
        return v;
      }
    }
    return v;
  };
  // ⚠ 三个读取器都必须先 unwrap：volatile 标记在**字段级**
  // （pillPosition / wrapToolbar / hideViewWhenNotMiMo），拿到的每个值都是引用对象。
  const num = (v, fallback) => {
    const x = unwrap(v);
    return Number.isFinite(Number(x)) ? Number(x) : fallback;
  };
  const str = (v, fallback) => {
    const x = unwrap(v);
    return typeof x === "string" ? x : fallback;
  };
  const bool = (v, fallback) => {
    const x = unwrap(v);
    return typeof x === "boolean" ? x : fallback;
  };
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
      // 非 MiMo 模型时是否隐藏整个「MiMo 用量」详情页（默认 false = 一直显示）
      hideViewWhenNotMiMo: bool(mimo.hideViewWhenNotMiMo, false),
      // 启用 MiMo 视觉路由：向 llm-pi-ai 写入 models[].input 含 image
      visionRouting: bool(mimo.visionRouting, false),
      // 额外为**纯文本**模型补 image（越权，风险自负，默认关）
      visionRoutingTextModels: bool(mimo.visionRoutingTextModels, false),
      visionRoutingAllMimo: bool(mimo.visionRoutingAllMimo, false),
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
 *   1. `process.argv[1]` —— dsh 启动入口 bin.js，即**正在运行的安装**，必然能
 *      解析 core 自己的依赖。0.2.0 起必须放第一位：profile 的软链树已退役，
 *      `ctx.baseUrl` 会解析到 last-good（**上一代**运行时快照）——版本错位，
 *      且快照会在下次升级时轮换，绝不能当真相来源。
 *   2. `ctx.baseUrl` → profile 目录。注意 Cordis 上下文是 Proxy，读未声明的属性
 *      会**直接抛错**，所以整段必须包 try —— 可选链 `?.` 也挡不住。
 *   3. `import.meta.url` —— 插件若被装进带依赖树的目录
 *   4. 进程 cwd
 *
 * @param {any} ctx 插件上下文（可为普通对象，测试时直接给 baseUrl）
 * @returns {any} schemastery 工厂；拿不到时 undefined
 */
function loadSchemaFactory(ctx) {
  const anchors = [];
  // 运行中的安装优先（理由见上方文档注释）；profile 锚点在 0.2.0+ 只作兜底
  if (typeof process.argv?.[1] === "string" && process.argv[1]) anchors.push(process.argv[1]);
  try {
    if (typeof ctx?.baseUrl === "string" && ctx.baseUrl.length > 0) {
      anchors.push(new URL("./__anchor__.js", ctx.baseUrl).href);
    }
  } catch {
    /* Proxy 上读 baseUrl 可能抛 —— 吞掉，换下一个锚点 */
  }
  anchors.push(import.meta.url);
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
/**
 * 拿不到 schemastery 时的**兜底 schema**，只为让 `settings.register` 成功。
 *
 * **为什么必须有它**：`settings.update(ns, patch)` 要求命名空间**已注册**，
 * 否则直接抛 `namespace "..." is not registered`。所以一旦注册失败，
 * 本插件就**彻底写不进配置** —— 包括改名迁移（用户的 Cookie 搬不过来）。
 * 原先的做法是"注册不了就整块跳过"，结果是：拿不到 schemastery 的环境里
 * 配置只读 + 迁移静默失效（测试抓到的就是这个）。
 *
 * 契约（`dsh-settings` 只用这两点）：
 *   · `schema(value)` → 解析后的值（用于 `resolve()`）
 *   · `schema.toJSON()` → 描述符（用于 `describe()`；**缺它会拖垮整个设置页**，
 *     见项目踩坑 1 —— 所以这里必须提供，且形状要合法）
 *
 * ⚠ 用**手工规范化**（`mimoSettingsSchema`）当解析函数：它自带默认值与类型收敛，
 * 且**不抛错**（脏输入也洗平），正好适合兜底。
 * ⚠ `toJSON()` 返回的是**最小可用描述符**（object + properties），
 * 不声明 `role:"secret"` —— 因为兜底路径下我们拿不到 schemastery 的元数据 API。
 * 这意味着**设置页里 Cookie 不会被标成密文**：这是兜底路径的取舍，
 * 正常情况下（有 schemastery）走真 schema，Cookie 仍是 secret。
 *
 * @returns {Function & { toJSON: () => object, type: string }}
 */
export function buildFallbackSettingsSchema() {
  const resolve = (input) => mimoSettingsSchema(input);
  resolve.type = "object";
  resolve.toJSON = () => ({
    type: "object",
    properties: {
      mimo: {
        type: "object",
        properties: {
          cookie: { type: "string", default: "" },
          cookieRef: { type: "string", default: "MIMO_CONSOLE_COOKIE" },
          planTotalTokens: { type: "number", default: 500000000 },
          pillPosition: { type: "string", default: "header" },
          wrapToolbar: { type: "boolean", default: true },
          hideViewWhenNotMiMo: { type: "boolean", default: false },
          visionRouting: { type: "boolean", default: false },
          visionRoutingTextModels: { type: "boolean", default: false },
          visionRoutingAllMimo: { type: "boolean", default: false },
        },
      },
    },
  });
  return resolve;
}

// 0.2 必需：DSH 的 settings.describe()/write() 走 volatileForm，**只保留带
// `.volatile()` 标记的叶子**。没有标记的字段会被逐层剔除 → dict 变空 →
// volatileForm 返回 undefined → 该命名空间被静默跳过（设置卡不出现），
// 保存报「has no volatile fields」。与 dsh-ui-cyanmod 用同一模式；
// 旧版 schemastery 无 volatile() 时原样返回，向后兼容。
function vol(field) {
  return field && typeof field.volatile === "function" ? field.volatile() : field;
}

export function buildMimoSettingsSchema(ctx) {
  const factory = loadSchemaFactory(ctx);
  if (!factory) return undefined;

  const inner = factory.object({
    mimo: factory.object({
      // 🔴 凡 GUI 可写字段都必须 .volatile()（平台契约，dsh-settings:501-525）：
      //    SettingsForms.write() 内部 `validatePaths(next, form)` 对合并结果的**每个键**
      //    校验 `isVolatilePath`，非 volatile 直接抛
      //    `Config field "mimo.<x>" is not volatile` —— 用户点保存就报"保存失败"。
      //    （update()/mutate() 都最终走 write()，所以没有旁路。）
      //    10-02 实测：planTotalTokens 等未标 → 保存报错，补齐后恢复。
      // 控制台 Cookie 是凭据：标 secret 后 describe() 会剥掉它并回传写入槽位
      cookie: vol(factory.string().default("").role("secret")),
      cookieRef: factory.string().default("MIMO_CONSOLE_COOKIE"),
      planTotalTokens: vol(factory.number().default(500_000_000)),
      pillPosition: vol(factory.string().default("header")),
      wrapToolbar: vol(factory.boolean().default(true)),
      hideViewWhenNotMiMo: vol(factory.boolean().default(false)),
      visionRouting: vol(factory.boolean().default(false)),
      visionRoutingTextModels: vol(factory.boolean().default(false)),
      visionRoutingAllMimo: vol(factory.boolean().default(false)),
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
      // 附带状态码：调用方要据此区分「登录失效(401)」与其它失败。
      // 光看错误字符串得正则匹配，脆且容易随上游文案变化而失效。
      return [false, {
        status: res.status,
        message: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
      }];
    }
    return [true, await res.json()];
  } catch (error) {
    return [false, { status: 0, message: error instanceof Error ? error.message : String(error) }];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** `fetchJson` 的失败值 → 可读消息（兼容旧的纯字符串形态）。 */
function msgOf(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.message === "string") return v.message;
  return String(v);
}

/** 该失败是不是「登录失效」（HTTP 401）。 */
function isUnauthorized(v) {
  return !!v && typeof v === "object" && v.status === 401;
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
/**
 * MiMo 模型的 Credits 倍率表（每百万 token），来自官方文档「用量与额度」。
 * 用于把本地 token 计数**估算**成 Credits —— 精度受缓存命中率与模型构成影响，
 * 结论只用于趋势对比，不做账单依据。
 */
const MIMO_CREDIT_RATES = {
  "mimo-v2.6-pro": { cache: 2.5, miss: 300, out: 600 },
  "mimo-v2.6-flash": { cache: 2, miss: 100, out: 200 },
  "mimo-v2.5-pro": { cache: 2.5, miss: 300, out: 600 },
  "mimo-v2.5": { cache: 2, miss: 100, out: 200 },
};
const MIMO_CREDIT_DEFAULT = { cache: 2, miss: 100, out: 200 };

/**
 * 一条 usage 的 Credits 估算。
 * 口径：官方把「输入」拆成命中缓存/未命中两档分别计价；本地计数的
 * `inputTokens` 不含缓存命中（total = input+output+cacheRead+cacheWrite），
 * 所以未命中输入 = input + cacheWrite；非小米模型返回 0（不烧 MiMo 额度）。
 * 夜间 0.8x 系数未建模（时段相关，摘要里注明）。
 */
/**
 * 非高峰时段折扣系数（官方「用量与额度」口径）：
 * **北京时间 00:00–08:00** 消耗系数 0.8 —— 即该时段的 Credits 按 8 折计。
 *
 * ⚠ 判定必须**按事件发生时刻**，不能按天：一个自然日跨了高峰/非高峰两段，
 *    按天会把整个白天都打折（高估节省）或整夜都不打折（低估）。
 * ⚠ 依赖运行环境的本地时区。本机是 Asia/Shanghai，与官方口径一致；
 *    若部署在别的时区，这里会偏 —— 所以用**固定的 UTC+8 偏移**换算，
 *    不依赖 `getHours()`（那读的是系统时区），保证在哪都对。
 */
const OFFPEAK_RATIO = 0.8;
export function isOffPeakHour(timeMs) {
  const t = Number.isFinite(timeMs) ? timeMs : Date.now();
  // 北京时间为 UTC+8，且中国不用夏令时 → 固定偏移即可
  const beijingHour = new Date(t + 8 * 3600_000).getUTCHours();
  return beijingHour >= 0 && beijingHour < 8;
}

export function estimateCredits(provider, model, usage, timeMs) {
  if (!isMiMoBaseURL(builtinBaseURL(provider)) && !/mimo/i.test(`${provider}/${model}`)) {
    return { total: 0, cache: 0, miss: 0, out: 0 };
  }
  const rates = MIMO_CREDIT_RATES[String(model).toLowerCase()] ?? MIMO_CREDIT_DEFAULT;
  const input = Number(usage?.inputTokens) || 0;
  const cacheRead = Number(usage?.cacheReadTokens) || 0;
  const cacheWrite = Number(usage?.cacheWriteTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  // 非高峰时段整单 8 折（三分量同乘，保持"分量之和 = 总量"）
  const ratio = isOffPeakHour(timeMs) ? OFFPEAK_RATIO : 1;
  const cCache = (cacheRead / 1e6) * rates.cache * ratio;
  const cMiss = ((input + cacheWrite) / 1e6) * rates.miss * ratio;
  const cOut = (output / 1e6) * rates.out * ratio;
  return { total: cCache + cMiss + cOut, cache: cCache, miss: cMiss, out: cOut, offPeak: ratio < 1 };
}

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
 *   2. `/dsh-mimo-extension/session` 恒返回 null → 胶囊与详情页的
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

  // 每日 Credits 三分量（缓存命中/未命中输入/输出），堆叠图与日均对比用
  const noteDay = (time, tokens, credits) => {
    const date = dateKeyOf(time);
    const hit = dayMap.get(date) ?? { date, tokens: 0, calls: 0, credits: 0, cCache: 0, cMiss: 0, cOut: 0 };
    hit.tokens += tokens;
    hit.calls += 1;
    if (credits) {
      hit.credits = (hit.credits ?? 0) + credits.total;
      hit.cCache = (hit.cCache ?? 0) + credits.cache;
      hit.cMiss = (hit.cMiss ?? 0) + credits.miss;
      hit.cOut = (hit.cOut ?? 0) + credits.out;
    }
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

    noteDay(ev.time, total, estimateCredits(provider, model, usage, ev.time));
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
        // 本月 Credits 估算（days[] 里带 credits 的才有；本地会话事件路径）
        monthCredits: days.some((d) => Number.isFinite(d.credits))
          ? days.reduce((sum, d) => sum + (d.credits ?? 0), 0)
          : undefined,
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

/**
 * provider 是不是**小米 MiMo 通道**。
 *
 * ⚠ 必须同时覆盖两类命名，只匹配 `mimo` 会漏掉平台内置的那批：
 *
 *   | 来源 | provider id | 含 `mimo`? |
 *   |---|---|---|
 *   | 自建（本工作区 settings.yaml） | `mimo` | ✅ |
 *   | **平台内置 pi-ai catalog** | **`xiaomi`**（按量） | ❌ |
 *   | **平台内置 pi-ai catalog** | **`xiaomi-token-plan-cn` / `-sgp` / `-ams`** | ❌ |
 *
 * 实测：用户选 `xiaomi-token-plan-cn/mimo-v2.5` 时，旧规则（只有 `/mimo/i`）
 * 把整个 MiMo 功能判成"非 MiMo" → 额度环不显示、详情页也不认。
 * 内置 provider 供的模型 id 是 `mimo-v2.5` / `mimo-v2.5-pro`
 * （见 `@earendil-works/pi-ai/dist/providers/data/xiaomi*.json`）。
 *
 * ⚠ 这里只回答"**名字像不像**小米通道" —— 它是**线索不是证据**。
 * 权威判据是 `resolveMiMoChannel()`（看解析后的 API 地址是不是小米域名）。
 * 计费类型另由 `billingTypeFor` 按地址/名称/套餐状态分别判
 * （`xiaomi` 这个内置 catalog 指向按量地址，与 `xiaomi-token-plan-*` 是两条通道）。
 *
 * @param {string} provider
 * @returns {boolean}
 */
const isMiMoProvider = (provider) =>
  typeof provider === "string" &&
  provider.length > 0 &&
  (/mimo/i.test(provider) || /^xiaomi(-|$)/i.test(provider));

/**
 * 模型 id 是不是 MiMo 模型（`mimo-v2.5`、`mimo-v2.5-pro`、`mimo-v2.6-flash`…）。
 *
 * ⚠ 需要它是因为**通道名与模型名可以不同源**：平台内置 provider 叫
 * `xiaomi-token-plan-cn`（不含 mimo），但它供的是 `mimo-v2.5`。
 *
 * @param {string} model
 * @returns {boolean}
 */
const isMiMoModel = (model) => typeof model === "string" && /mimo/i.test(model);

/**
 * 小米官方域名 —— **这才是"属于 MiMo"的铁证**。
 *
 * 只认官方域名，不看名字：自建网关可能叫 `mimo-anything` 却转发到别家；
 * 反过来 `xiaomi` 这种内置 id 又完全不含 `mimo`。名字只能当线索。
 */
const MIMO_HOST_RE = /(^|\.)xiaomimimo\.com$/i;

/**
 * 从 API 地址判断"是不是小米通道"（比名字可靠）。
 *
 * @param {string} baseURL - 解析后的 API 地址
 * @returns {boolean|null} true=是小米；false=明确不是；null=地址未知，无法据此判断
 */
export function isMiMoBaseURL(baseURL) {
  const raw = typeof baseURL === "string" ? baseURL.trim() : "";
  if (!raw) return null;
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    // 不是合法 URL：退化为按字符串找域名（自建网关可能只写了个前缀）
    const m = /([a-z0-9.-]*xiaomimimo\.com)/i.exec(raw);
    if (!m) return null;
    host = m[1];
  }
  return MIMO_HOST_RE.test(host);
}

/**
 * 平台**内置 pi-ai catalog** 里各 provider 的 API 地址。
 *
 * 为什么要把这张表内联：内置 provider（`xiaomi*`）的地址**不在 settings.yaml**，
 * 而是 pi-ai 包 `dist/providers/*.js` 里的 `baseUrl`，插件无法 `require`
 * `@earendil-works/pi-ai`（不在 profile 依赖树里）。所以把实测值抄进来。
 *
 * ⚠ 与上游同步：值取自
 * `runtime/node_modules/@earendil-works/pi-ai/dist/providers/xiaomi*.js`。
 * 升级 dsh 后如发现地址变了，用下面这条命令核对：
 *   grep -oE 'baseUrl: *"[^"]*"' <runtime>/node_modules/@earendil-works/pi-ai/dist/providers/xiaomi*.js
 *
 * @type {Record<string, string>}
 */
export const BUILTIN_PROVIDER_BASE_URLS = {
  xiaomi: "https://api.xiaomimimo.com/v1",
  "xiaomi-token-plan-cn": "https://token-plan-cn.xiaomimimo.com/v1",
  "xiaomi-token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com/v1",
  "xiaomi-token-plan-ams": "https://token-plan-ams.xiaomimimo.com/v1",
};

/**
 * 平台 catalog 里**声明了图像输入**的小米模型（多模态）。
 *
 * 数据来源：`@earendil-works/pi-ai/dist/providers/data/xiaomi*.json` 的
 * `input` 字段（实测抓取）：
 *
 *   | provider | 模型 | input |
 *   |---|---|---|
 *   | xiaomi / xiaomi-token-plan-{cn,sgp,ams} | **mimo-v2.5** | **["text","image"]** |
 *   | 同上 | mimo-v2.5-pro | ["text"] |
 *   | xiaomi | mimo-v2.5-pro-ultraspeed | ["text"] |
 *
 * ⚠ **只把多模态的列进来**。「视觉路由」开关据此**只对真正支持图像的模型**
 * 写入 `input: ["text","image"]` —— 不给 `-pro` 之类的纯文本模型撑腰，
 * 否则发图会被上游拒绝或静默丢弃（那是更糟的失败：用户以为发出去了）。
 *
 * ⚠ 与上游同步：升级 dsh 后核对
 *   `python3 -c "import json;d=json.load(open('<pi-ai>/dist/providers/data/xiaomi.json'));..."`，
 *   或直接看 `input` 字段。新增多模态模型时把它加进这里。
 *
 * 匹配方式：**按模型 id 前缀**（`mimo-v2.5` 精确匹配，避免误伤 `mimo-v2.5-pro`）。
 */
export const BUILTIN_MULTIMODAL_MODELS = [
  { provider: "xiaomi", model: "mimo-v2.5" },
  { provider: "xiaomi-token-plan-cn", model: "mimo-v2.5" },
  { provider: "xiaomi-token-plan-sgp", model: "mimo-v2.5" },
  { provider: "xiaomi-token-plan-ams", model: "mimo-v2.5" },
];

/**
 * 该 provider/model 是否是**平台 catalog 声明的多模态小米模型**。
 *
 * ⚠ 精确匹配模型 id（不是前缀），所以 `mimo-v2.5-pro` **不会**命中
 * `mimo-v2.5` —— 这是刻意的：`-pro` 在 catalog 里是纯文本。
 * 自建 provider（如 `mimo`）不在内置表里，返回 false（它的模型清单是用户
 * 自己声明的，能力也该由用户自己声明）。
 *
 * @param {string} provider
 * @param {string} model
 * @returns {boolean}
 */
/**
 * 平台 catalog 里**纯文本**的小米模型（`input` 不含 image）。
 *
 * 用途：可选的「为文本模型提供视觉能力」开关据此**只**给这些模型补 image。
 * 与 `BUILTIN_MULTIMODAL_MODELS` 分开维护，是为了**回收干净**：
 * 关闭开关时只删我们加上的那些，绝不误删 catalog 本就声明 image 的模型。
 *
 * ⚠ 硬给纯文本模型声明 image 是**越权**行为：上游可能拒绝，
 * 或**静默丢弃图片**（用户以为发出去了 —— 比明确报错更糟）。
 * 所以它单独一个开关、默认关闭，且文案要写明风险。
 *
 * 数据来源同 `BUILTIN_MULTIMODAL_MODELS`（pi-ai `dist/providers/data/xiaomi*.json`）。
 */
export const BUILTIN_TEXT_ONLY_MODELS = [
  { provider: "xiaomi", model: "mimo-v2.5-pro" },
  { provider: "xiaomi", model: "mimo-v2.5-pro-ultraspeed" },
  { provider: "xiaomi-token-plan-cn", model: "mimo-v2.5-pro" },
  { provider: "xiaomi-token-plan-sgp", model: "mimo-v2.5-pro" },
  { provider: "xiaomi-token-plan-ams", model: "mimo-v2.5-pro" },
];

export function isBuiltinMultimodal(provider, model) {
  if (typeof provider !== "string" || typeof model !== "string") return false;
  return BUILTIN_MULTIMODAL_MODELS.some((e) => e.provider === provider && e.model === model);
}

/**
 * 综合判定「当前选中模型是否属于 MiMo 通道」，**以 API 地址为准**。
 *
 * 判定顺序（名字只是线索，地址才是证据）：
 *   1. 地址明确是小米域名 → **是**（无论 provider 叫什么）
 *   2. 地址明确不是小米域名 → **不是**（哪怕 provider 叫 `mimo-xxx`）
 *   3. 地址未知（自建网关未写 baseURL 等）→ 退回名字线索：
 *      provider 命中 `isMiMoProvider` **或** model 命中 `isMiMoModel` 才算，
 *      并在返回值里标 `certain:false`，UI 可据此保守处理。
 *
 * @param {object} input
 * @param {string} [input.provider]
 * @param {string} [input.model]
 * @param {string} [input.baseURL] - 解析后的 API 地址（可为空）
 * @returns {{isMiMo: boolean, certain: boolean, reason: string}}
 *   `certain` 为 false 表示"地址没读到、只能按名字猜"
 */
export function resolveMiMoChannel({ provider, model, baseURL } = {}) {
  const byUrl = isMiMoBaseURL(baseURL);
  if (byUrl === true) return { isMiMo: true, certain: true, reason: "baseURL" };
  if (byUrl === false) return { isMiMo: false, certain: true, reason: "baseURL" };
  // 地址未知 → 名字线索（不确信）
  if (isMiMoProvider(provider)) return { isMiMo: true, certain: false, reason: "provider-name" };
  if (isMiMoModel(model)) return { isMiMo: true, certain: false, reason: "model-name" };
  return { isMiMo: false, certain: false, reason: "unknown" };
}

/**
 * 内置 provider 的地址（settings.yaml 没写 baseURL 时用它兜底）。
 *
 * @param {string} provider
 * @returns {string}
 */
export function builtinBaseURL(provider) {
  return typeof provider === "string" ? BUILTIN_PROVIDER_BASE_URLS[provider] ?? "" : "";
}

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

  // 3) provider 名含 token-plan
  if (/token-plan/i.test(provider)) return "token-plan";

  // 4) 小米通道 + 地址未知 → 用官方套餐状态兜底。
  //
  // ⚠ 必须**先确认地址不是"明确非小米"**：`billingTypeFromBaseURL` 只认官方
  // 域名，返回 null 有两种含义 —— "没读到地址" 与 "读到了但不是小米域名"。
  // 后者（如自建网关 `mimo-gateway` → api.openai.com）**不能**再按名字判套餐，
  // 否则一个名字带 mimo 却转发到别家的路由会被误标成 Token Plan。
  const urlKnownNonMiMo = isMiMoBaseURL(baseURL) === false;
  if (!urlKnownNonMiMo && isMiMoProvider(provider)) {
    if (planStatus === "expired" || planStatus === "none") return "payg";
    return "token-plan";
  }

  // 5) 非小米通道、也没过请求（provider 为空）时保持按量这个保守默认，
  //    调用方会用 `providerKnown` 决定是否展示该结论。
  return "payg";
}

/** 每日 Credits 聚合的落盘路径（`<home>/dsh-mimo-extension/daily-credits.json`）。 */
function dailyCreditsFilePath() {
  let home = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.replace(/\/+$/, "") : "";
  if (!home) {
    // 与 apply 层同样的走查：向上找 `profiles` 目录的父级
    try {
      let cur = new URL(".", import.meta.url).pathname;
      for (let i = 0; i < 8; i += 1) {
        try {
          if (statSync(`${cur}profiles`).isDirectory()) { home = cur.replace(/\/+$/, ""); break; }
        } catch { /* 继续向上 */ }
        const up = cur.replace(/[^/]+\/$/, "");
        if (up === cur) break;
        cur = up;
      }
    } catch { /* 忽略 */ }
  }
  return home ? `${home}/dsh-mimo-extension/daily-credits.json` : null;
}

/**
 * 每日 Credits 聚合落盘（60s 节流）。
 *
 * 为什么需要：本地 days 来自存活会话重算，会话删除/重启即丢历史；
 * 而「MiMo 模式省不省 Credits」是**跨天趋势**问题，必须有稳定历史。
 * 同日条目被本地重算覆盖（重算是全量真相），更早的历史只增不减。
 *
 */
function persistDailyCreditsSync(summary) {
  const file = dailyCreditsFilePath();
  if (!file) return;
  let store = { days: {}, modeTimeline: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      store.days = parsed.days && typeof parsed.days === "object" ? parsed.days : {};
      if (Array.isArray(parsed.modeTimeline)) store.modeTimeline = parsed.modeTimeline;
    }
  } catch { /* 首次或损坏 → 从空开始 */ }
  // 🔴 按字段取**最大值**合并，不做整体覆盖。
  //
  // 为什么不能用覆盖：`summary.local.days` 来自**当前存活会话**的重算
  // （`token-usage/` 目录不存在时走进程内会话统计，见 buildSummary 的取数顺序），
  // 而会话会被删除、core 会重启 —— 重算结果**可能比上一次小**。
  // 旧实现 `store.days[date] = {...}` 会把一整天抹成"最后一个被 ingest 的会话"
  // 的量（实测 09-27 因此低估约 98 倍：文件 4.31 credits vs 逐笔加总 422.04）。
  // 单日内的各分量都是单调累加的，所以取 max 是**单调、不丢历史**的安全合并。
  // ⚠ 已知残留：这仍无法还原"被删除会话"贡献的那部分（只保证不倒退）；
  //    要彻底精确需按 sessionId 累计，属后续工作。
  const pickMax = (prev, next) => {
    const a = Number.isFinite(prev) ? prev : 0;
    const b = Number.isFinite(next) ? next : 0;
    return Math.max(a, b);
  };
  for (const d of summary?.local?.days ?? []) {
    if (!d?.date) continue;
    const prev = store.days[d.date] ?? {};
    store.days[d.date] = {
      tokens: pickMax(prev.tokens, d.tokens ?? 0),
      calls: pickMax(prev.calls, d.calls ?? 0),
      credits: pickMax(prev.credits, d.credits ?? 0),
      cCache: pickMax(prev.cCache, d.cCache ?? 0),
      cMiss: pickMax(prev.cMiss, d.cMiss ?? 0),
      cOut: pickMax(prev.cOut, d.cOut ?? 0),
    };
  }
  try {
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, JSON.stringify(store));
  } catch { /* 落盘失败不影响 summary */ }
}

/**
 * 读历史并算「MiMo 模式开启前后」的日均 Credits 对比。
 * 样本要求：开启前 ≥2 天、开启后 ≥1 天 —— 否则不给结论（避免用单日噪声下判断）。
 */
function loadCreditsStats() {
  const file = dailyCreditsFilePath();
  if (!file) return null;
  let store;
  try {
    store = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const days = store?.days && typeof store.days === "object" ? store.days : {};
  const tl = Array.isArray(store?.modeTimeline) ? store.modeTimeline : [];
  if (!tl.length) return { days, modeTimeline: tl, compare: null };
  const lastOn = [...tl].reverse().find((e) => e.on === true);
  if (!lastOn) return { days, modeTimeline: tl, compare: null };
  const startDate = new Date(lastOn.at).toISOString().slice(0, 10);
  const before = [];
  const after = [];
  for (const [date, d] of Object.entries(days)) {
    if (!Number.isFinite(d?.credits)) continue;
    (date < startDate ? before : after).push(d.credits);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const beforeAvg = avg(before);
  const afterAvg = avg(after);
  const compare = beforeAvg !== null && afterAvg !== null && before.length >= 2 && after.length >= 1
    ? { startDate, beforeDays: before.length, afterDays: after.length, beforeAvg, afterAvg,
        deltaPct: beforeAvg > 0 ? ((afterAvg - beforeAvg) / beforeAvg) * 100 : null }
    : null;
  return { days, modeTimeline: tl, compare };
}

/**
 * 汇总 MiMo 状态（胶囊与详情页共用）。
 * @param {object} deps - { ctx, cfg, getCounter }
 * @param {AbortSignal} [signal]
 */
async function buildSummary(deps, signal, options = {}) {
  const { ctx, cfg, getCounter } = deps;
  // 用户层设置（设置页保存）优先于 patch 层 config
  const mimo = deps.currentMimo?.() ?? cfg.mimo ?? DEFAULT_CONFIG.mimo;
  const { cookie, source: cookieSource } = await resolveCookie(ctx, mimo);
  const apiBase = (process.env.MIMO_API_URL || DEFAULT_MIMO_API).replace(/\/+$/, "");

  const result = {
    official: false,
    officialError: "",
    // 登录是否失效（官方接口 401）。与「网络/上游故障」分开 —— 前者要用户重新登录。
    authExpired: false,
    stale: false,
    staleAt: null,
    cookieSource,
    plan: null,
    planUsage: null,
    // 官方套餐状态（active/expired/none/unknown），供计费类型判定用
    planStatus: "unknown",
    balance: null,
    local: null,
    billingType: "token-plan",
    providerBaseURL: "",
    // 「是否 MiMo 通道」（以地址为准，见 resolveMiMoChannel）
    isMiMo: false,
    isMiMoCertain: false,
    isMiMoReason: "unknown",
    model: "",
    provider: "",
    sessionTokens: 0,
    priceSource: "fallback",
    price: mimo.pricing?.fallbackPrice ?? DEFAULT_CONFIG.mimo.pricing.fallbackPrice,
    updatedAt: Date.now(),
  };

  // 1) 官方三连 —— 走 deps.getOfficial：网络部分按 CACHE_TTL 单独缓存，
  //    本地部分每次都重算（拆分理由见该函数注释）。refresh=1 时强制重取。
  const official = await deps.getOfficial({ apiBase, cookie, signal, force: options.refreshOfficial === true });
  result.planStatus = official.planStatus;
  result.official = official.official;
  result.officialError = official.officialError;
  result.authExpired = official.authExpired === true;
  // 缓存兜底：official=true 但 stale=true ⇒ 数据是上次成功时的快照
  result.stale = official.stale === true;
  result.staleAt = official.staleAt ?? null;
  result.plan = official.plan;
  result.planUsage = official.planUsage;
  result.balance = official.balance;

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
  // 「是否 MiMo 通道」的权威结论：**以地址为准**，名字只作地址缺失时的线索。
  // 供胶囊可见性与详情页开关使用（旧版只按 provider 名匹配 `/mimo/i`，
  // 漏掉了平台内置的 `xiaomi-token-plan-cn`）。
  const channel = resolveMiMoChannel({
    provider: result.provider,
    model: result.model,
    baseURL: result.providerBaseURL,
  });
  result.isMiMo = channel.isMiMo;
  result.isMiMoCertain = channel.certain;
  result.isMiMoReason = channel.reason;
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
    // ⚠ 必须 deref + 白名单：volatile 字段是引用对象，`?? "header"` 不回落（truthy），
    // 漏出去会让浏览器收到 `{}`（详细根因见 derefVolatile 的注释）。
    pillPosition: pickVolatile(mimo.pillPosition, PILL_POSITIONS, "header"),
    wrapToolbar: mimo.wrapToolbar !== false,
    hideViewWhenNotMiMo: mimo.hideViewWhenNotMiMo === true,
    visionRouting: mimo.visionRouting === true,
    visionRoutingTextModels: mimo.visionRoutingTextModels === true,
    visionRoutingAllMimo: mimo.visionRoutingAllMimo === true,
  };

  // 浏览器半边的自诊断回传（脚本加载 → 工厂 → apply），诊断"装了没生效"
  result.client = deps.lastClientPing ?? null;
  result.clientLog = deps.clientLog ?? [];

  result.updatedAt = Date.now();
    // 每日 Credits 落盘（节流）+ 给前端的历史/对比数据
  try {
    persistDailyCreditsSync(result);
  } catch { /* 落盘失败不影响 summary */ }
  result.creditsStats = loadCreditsStats();
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
  // 没有它，`/dsh-mimo-extension/session` 会恒返回 null → 会话用量恒为 0。
  deps.localCounter = createLocalUsageCounter(ctx);

  // provider 的 API 地址 —— **两级来源**：
  //   ① `llm-pi-ai` 命名空间的 providers.<id>.baseURL（自建 provider 写在这里）
  //   ② `BUILTIN_PROVIDER_BASE_URLS`（平台内置 pi-ai catalog 的地址，
  //      settings.yaml 里**没有** baseURL 字段，插件也无法 require pi-ai 包）
  //
  // 为什么非要拿到地址：小米按量（api.xiaomimimo.com）与套餐
  // （token-plan-<region>.xiaomimimo.com）是**两条通道**，地址是判计费类型与
  // "是不是 MiMo"最可靠的证据 —— 名字会骗人（`xiaomi` 不含 mimo、
  // 自建网关可能叫 `mimo-xxx` 却指向别家）。
  let settingsService = null;
  // 0.2 读**别人的**命名空间必须走 configEditor（官方 `ctx.get("configEditor")`）：
  //   `settings.get(ns)` 在 0.2 的 SettingsForms 上**根本不存在**（只有
  //   describe/schema/update/mutate/write/replace）→ 调用必抛 → 被 catch 吞掉 →
  //   表现为「读不到 llm-pi-ai 命名空间」（视觉路由失败的真正原因）。
  //   describe() 内部用的也是同一条路径：configEditor.configuration() 返回
  //   [{entry, inherited, override}]，其中 inherited 是**组合后的继承值**。
  let configEditor = null;
  /**
   * 读任意命名空间的**组合后配置**（不要求该 ns 由本插件注册）。
   *
   * @param {string} ns 配置条目的 id（如 "llm-pi-ai" / "agent-default-model"）。
   * @returns {any} 该条目的 inherite 配置对象；条目不存在或服务不可用时 null。
   */
  function readNamespaceDoc(ns) {
    if (!configEditor || typeof configEditor.configuration !== "function") return null;
    try {
      const rows = configEditor.configuration();
      const row = Array.isArray(rows) ? rows.find((r) => r?.entry?.options?.id === ns) : null;
      return row?.inherited ?? null;
    } catch {
      return null;
    }
  }
  deps.readNamespaceDoc = readNamespaceDoc;
  deps.providerBaseURL = (provider) => {
    if (!provider) return "";
    {
      // 0.2：走 configEditor（settings.get 不存在）——读不到就落到内置表
      const doc = readNamespaceDoc("llm-pi-ai");
      const url = doc?.providers?.[provider]?.baseURL;
      if (typeof url === "string" && url) return url;
    }
    return builtinBaseURL(provider);
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
    // 0.2：走 configEditor（settings.get 不存在）
    const doc = readNamespaceDoc("agent-default-model");
    if (!doc) return null;
    const provider = typeof doc.provider === "string" ? doc.provider : "";
    const model = typeof doc.model === "string" ? doc.model : "";
    if (!provider && !model) return null;
    return { provider, model };
  };
  deps.readDefaultModel = readDefaultModel;

  // ── 官方三连（网络）单独缓存 —— 这是"拆缓存"的实现 ──────────────────
  //
  // summary 里混了两类数据：
  //   · 本地即时类：provider / 计费类型 / 单价 / token 计数 / UI 偏好
  //     —— 随用户操作变化（切模型、刚发完消息），**不能缓存**，
  //     否则弹窗里 token 数最长滞后 60s（或显示上一个渠道的计费类型）。
  //   · 官方三连：balance / tokenPlan/detail / tokenPlan/usage
  //     —— 占 **100% 的网络成本**（实测 3 个外部请求 ≈ 0.18s），
  //     而额度以分钟计变化，60s 缓存完全合理；**故障时结果也进缓存**，
  //     相当于对上游的隐式熔断，避免每分钟直冲一个正在故障的接口。
  //
  // ⚠ 不要退回"整体 60s 缓存"，也不建议直接关掉 TTL：
  //   ① 三个 fetchJson 原先是串行 await，上游 hang 时最坏 3 × 15s = 45s，
  //      无缓存意味着**每分钟**所有 /summary 都重吃一遍；
  //   ② 多标签页无法共享，账号 Cookie 的请求频率被放大。
  let officialCache = null;
  let officialAt = 0;
  // ── 最后一次成功结果的快照（缓存兜底）──────────────────────────
  // 用户反馈（09-28）：Cookie 过期后，之前拿到的官方数据就没了 ——
  // 界面退回「本地估算」，把真实套餐数据丢掉很可惜。
  // 现在成功时额外留一份快照；之后 401/网络失败时返回它并打上
  // `stale` 标记（`staleAt` = 数据的实际时间），让界面能如实标注
  // 「当前为缓存数据」。
  // ⚠ 快照**不带过期上限**：数据多旧由 `staleAt` 如实呈现，交给用户判断
  //   （套餐数据变化慢，几周前的余额也仍有参考价值）。
  let lastGoodOfficial = null;
  let lastGoodAt = 0;
  let officialInflight = null;
  deps.getOfficial = async ({ apiBase, cookie, signal, force } = {}) => {
    if (!cookie) {
      return {
        official: false,
        officialError: "未配置 Cookie（config.mimo.cookie / 凭据 MIMO_CONSOLE_COOKIE）",
        authExpired: false,
        planStatus: "unknown",
        plan: null,
        planUsage: null,
        balance: null,
      };
    }
    if (!force && officialCache && Date.now() - officialAt < CACHE_TTL_MS) return officialCache;
    if (officialInflight) return officialInflight;
    officialInflight = (async () => {
      // 并行（原为 3 个串行 await）：最坏 45s → 15s，常态 180ms → 60ms
      const [[okB, rawB], [okD, rawD], [okU, rawU]] = await Promise.all([
        fetchJson(`${apiBase}/balance`, cookie, signal),
        fetchJson(`${apiBase}/tokenPlan/detail`, cookie, signal),
        fetchJson(`${apiBase}/tokenPlan/usage`, cookie, signal),
      ]);
      const balance = okB ? parseBalance(rawB) : null;
      const plan = okD ? parseTokenPlanDetail(rawD) : null;
      const usage = okU ? parseTokenPlanUsage(rawU) : null;
      // 套餐状态单独记：它决定 provider `mimo` 判套餐还是按量
      const value = {
        planStatus: planStatusOf(okD, rawD, plan),
        official: false,
        officialError: "",
        authExpired: false,
        plan: null,
        planUsage: null,
        balance: null,
      };
      if (balance || usage) {
        value.official = true;
        value.balance = balance;
        value.plan = plan;
        value.planUsage = usage;
        // 成功 → 更新快照（浅拷贝即可：value 每次新建，字段都是本次请求的）
        lastGoodOfficial = { ...value };
        lastGoodAt = Date.now();
      } else {
        const errs = [];
        if (!okB) errs.push(`balance: ${msgOf(rawB)}`);
        if (!okD) errs.push(`detail: ${msgOf(rawD)}`);
        if (!okU) errs.push(`usage: ${msgOf(rawU)}`);
        value.officialError = errs.join("; ") || "empty responses";
        // 登录是否失效（三个接口任一明确 401）—— 与「网络抖动/上游故障」区分开：
        // 前者要用户重新登录，后者等重试即可，界面提示完全不同。
        value.authExpired =
          isUnauthorized(rawB) || isUnauthorized(rawD) || isUnauthorized(rawU);

        // ── 缓存兜底（用户需求：过期后保留之前的数据）──────────────────
        // 失败时若手里有成功快照，就返回它并打上 `stale` 标记 ——
        // 界面据此显示「当前为缓存数据（截至 X）」，而不是退回粗粒度的
        // 本地估算。真实套餐数据比估算有用得多。
        // ⚠ 仅 401（登录失效）与网络/上游失败都兜 —— 两者的区别只体现在
        //   `authExpired` 与界面文案上。
        if (lastGoodOfficial) {
          const stale = {
            ...lastGoodOfficial,
            authExpired: value.authExpired,
            officialError: value.officialError,
            stale: true,
            staleAt: lastGoodAt,
            // 数据虽是快照，但「套餐状态」的结论沿用快照当时的 —— 已注明
          };
          officialCache = stale;
          officialAt = Date.now();
          return stale;
        }
      }
      officialCache = value;
      officialAt = Date.now();
      return value;
    })().finally(() => {
      officialInflight = null;
    });
    return officialInflight;
  };
  /** Cookie 等设置变化时作废官方数据（改了 Cookie 必须立刻重取）。 */
  deps.clearOfficialCache = () => {
    officialCache = null;
    officialAt = 0;
  };

  // ── 视觉路由：把 `input: ["text","image"]` 写进 llm-pi-ai 的模型声明 ──────
  //
  // **为什么需要写**：平台按 `inputModalities` 硬拦截图片附件
  // （`dsh-api-session-controller` 抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`），
  // 而该值最终来自 `llm-pi-ai` 里每个模型的 `input`。catalog 虽然给
  // `mimo-v2.5` 标了 `["text","image"]`，但**用户/工具一旦在 settings.yaml
  // 显式列出 models（本机就是这样），能力就可能被收窄成 `["text"]`**。
  // 这个开关把多模态模型的 `input` 显式写全，等价于 openai-codex 的做法。
  //
  // **只写真正多模态的模型**（见 `BUILTIN_MULTIMODAL_MODELS`），
  // 别的 MiMo 模型（`-pro` 等）一律不碰 —— 避免"声明了却不被上游接受"。
  //
  // 实现用 `mutate` 的**路径寻址**：只改目标模型那一个字段，
  // 不重写整个 provider（那会覆盖用户的其它设置）。
  /**
   * 让 llm-pi-ai 里多模态 MiMo 模型的 input 与 `enable` 一致。
   *
   * @param {boolean} enable - true=声明图像输入；false=回收成 ["text"]
   * @returns {Promise<{changed: string[], error: string}>}
   */
  deps.applyVisionRouting = async (enable, allowTextOnly = false, allowAllMimo = false) => {
    const changed = [];
    if (!settingsService || typeof settingsService.mutate !== "function") {
      return { changed, error: "设置服务不可写（settings.mutate 不可用）" };
    }
    // 0.2：走 configEditor 读组合后的 llm-pi-ai 配置（settings.get 在 0.2 不存在，
    // 旧写法必然抛错 → 用户看到「视觉路由设置失败：读不到 llm-pi-ai 命名空间」）。
    const doc = readNamespaceDoc("llm-pi-ai");
    if (!doc) {
      return { changed, error: "读不到 llm-pi-ai 命名空间（configEditor 不可用或条目缺失）" };
    }
    const providers = doc.providers ?? {};

    // 目标与「该不该有 image」的判定 —— **统一 want 函数，单一事实来源**。
    // 三个开关各认领一块，按模型取并集；谁关了就重算，不会互相打架：
    //   ① 主开关        ：多模态表（内置渠道 + 自建小米渠道的 v2.5 / v2.6）
    //   ② 子开关        ：纯文本表（…-pro / -ultraspeed）
    //   ③ 全量开关(新)  ：**判定为 MiMo 渠道**上的全部模型 —— 复用既有的
    //      resolveMiMoChannel（地址优先、名字兜底），覆盖上一轮按 id 模式
    //      匹配漏掉的：别名模型、地址未知的自建网关、未来新模型。
    //
    // ⚠ 管辖边界（安全的根基）：**只有"被任一开关管辖"的模型才会被改写**。
    //    判定函数 `managed()` 与开关状态无关（纯检测）；开关只影响 `want`。
    //    这样：关掉某个开关 → 它管辖的模型被回收；但 **管辖之外的模型
    //    （如 openai-codex 的 `["text","image"]`）永远原样保留** ——
    //    若把"非候选"也当 want=false 处理，会把用户/目录声明的 image 剥掉。
    const keyOf = (providerName, modelId) => `${providerName}\u0000${modelId}`;
    const mmKeys = new Set(BUILTIN_MULTIMODAL_MODELS.map((e) => keyOf(e.provider, e.model)));
    const txtKeys = new Set(BUILTIN_TEXT_ONLY_MODELS.map((e) => keyOf(e.provider, e.model)));

    // 自建小米渠道的动态归类（沿用上一轮：地址判定 + id 模式 → 归入 ①/②）
    for (const [providerName, profile] of Object.entries(providers)) {
      if (!isMiMoBaseURL(profile?.baseURL)) continue;
      for (const m of Array.isArray(profile?.models) ? profile.models : []) {
        const id = String(m?.id ?? "");
        if (!/^mimo-/i.test(id)) continue;
        const k = keyOf(providerName, id);
        if (/-pro|-ultraspeed/i.test(id)) txtKeys.add(k); else mmKeys.add(k);
      }
    }

    /** 渠道级 MiMo 判定：内置渠道没有 baseURL，用 `builtinBaseURL` 兜底。 */
    const channelIsMimo = (providerName, profile) =>
      resolveMiMoChannel({
        provider: providerName,
        baseURL: profile?.baseURL ?? builtinBaseURL(providerName),
      }).isMiMo === true;

    /** 该模型是否被任一开关**管辖**（管辖之外 → 永不改动）。 */
    const managed = (providerName, modelId, profile) => {
      const k = keyOf(providerName, modelId);
      return mmKeys.has(k) || txtKeys.has(k) || channelIsMimo(providerName, profile);
    };
    /** 该模型**现在**是否应该声明 image（三个开关取并集）。 */
    const wantImage = (providerName, modelId, profile) => {
      if (!enable) return false;
      const k = keyOf(providerName, modelId);
      if (mmKeys.has(k)) return true;
      if (allowTextOnly && txtKeys.has(k)) return true;
      if (allowAllMimo && channelIsMimo(providerName, profile)) return true;
      return false;
    };

    // 🔴 **绝不能把数组下标写进 path**（线上事故，09-28 修）。
    //
    // 平台的 `applyPathOp()` 只认 **plain object**：
    //     const child = section[head];
    //     if (!isPlainObject(child)) return { ...section, [head]: applyPathOp({}, …) };
    // 而 **数组不是 plain object** → 走到 `models` 这一层时，整个数组被当成
    // 空对象重建。实测后果：
    //     原: models = [{id:'mimo-v2.5'}, {id:'mimo-v2.5-pro'}]
    //     写后: models = {"0": {"input": ["text","image"]}}
    //   → 数组降级成对象、**连 id/name 都丢了** → `llm-pi-ai` schema 期望数组，
    //     校验失败 → **整个 provider 被丢弃**（用户模型菜单里的 MiMo-V2.5 消失，
    //     且"视觉路由"看起来像是没保存成功）。
    //
    // ✅ 正确做法：**整条 models 数组替换**（path 只到 `models`，不进入数组），
    //   把改好的新数组作为 value。这样完全不碰 applyPathOp 的数组缺陷。
    // ⚠ **必须按 provider 聚合**：op 是"整条 models 数组替换"，
    // 同一 provider 推多条就会互相覆盖（实测 xiaomi 被推了 2 条，
    // 后一条把前一条的结果盖掉 → 只有一个模型被改）。所以先按 provider 分组，
    // 每个 provider 只算一次、只推一条 op。
    const ops = [];
    // 遍历**所有** provider（不再只遍历目标表）—— 管辖判定在 wantImage/managed 里，
    // 管辖之外的模型原样保留（见上方 `managed` 的说明）。
    for (const [provider, profile] of Object.entries(providers)) {
      const list = profile?.models;
      if (!Array.isArray(list)) continue; // 该 provider 没配 → 不动
      let touched = false;
      const nextList = list.map((m) => {
        if (!m?.id) return m;
        // 🔴 管辖之外的模型 → 原样保留（哪怕它声明了 image）。
        //    典型：openai-codex 的 gpt-* 本就带 image，是用户/目录声明的，
        //    绝不能被我们当"多余的 image"回收掉。
        if (!managed(provider, m.id, profile)) return m;
        const cur = m.input;
        const hasImage = Array.isArray(cur) && cur.includes("image");
        const want = wantImage(provider, m.id, profile);
        if (want === hasImage) return m; // 无需变更
        // 保留已有其它模态（去重），按需增删 image
        const next = want
          ? (Array.isArray(cur) && cur.length ? [...new Set([...cur, "image"])] : ["text", "image"])
          : ((Array.isArray(cur) ? cur.filter((x) => x !== "image") : []).length
              ? cur.filter((x) => x !== "image")
              : ["text"]);
        touched = true;
        changed.push(`${provider}/${m.id}`);
        return { ...m, input: next };
      });
      if (!touched) continue;
      ops.push({ op: "set", path: ["providers", provider, "models"], value: nextList });
    }
    if (ops.length === 0) return { changed, error: "" };
    try {
      await settingsService.mutate("llm-pi-ai", ops);
      return { changed, error: "" };
    } catch (error) {
      return { changed: [], error: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 按当前偏好同步视觉路由；供插件启动与设置保存后调用。
   * 失败只记警告 —— 它不该拖垮插件的其它功能。
   */
  deps.syncVisionRouting = async () => {
    const mimo = deps.currentMimo?.() ?? cfg.mimo ?? DEFAULT_CONFIG.mimo;
    const want = mimo.visionRouting === true;
    // 文本模型只在视觉路由也开的前提下才补 image（单独开没有意义）
    const allowTextOnly = want && mimo.visionRoutingTextModels === true;
    // 全量口径同样只在主开关开启时才有意义
    const allowAllMimo = want && mimo.visionRoutingAllMimo === true;
    const { changed, error } = await deps.applyVisionRouting(want, allowTextOnly, allowAllMimo);
    if (error) {
      ctx.logger?.warn?.(`[dsh-mimo-extension] 视觉路由同步失败：${error}`);
    } else if (changed.length) {
      ctx.logger?.info?.(
        `[dsh-mimo-extension] 视觉路由已${want ? "开启" : "关闭"}（文本模型：${allowTextOnly ? "是" : "否"}；全量：${allowAllMimo ? "是" : "否"}）：${changed.join(", ")}`,
      );
    }
    return { changed, error };
  };

  // 跟踪当前生效的 provider/model。
  // 优先级：**当前选中的默认模型**（与 UI 同源，切了就算）→ request/header 事件
  //        → 落盘计数器快照 → 内置统计快照 → 空值。
  // 把「默认模型」放第一位，是因为它才是"用户此刻选的是什么"；
  // 事件流的语义是"最近一次真的用过什么"，切了模型但没发消息时会滞后。
  // （会话预设的安装/移除已迁到独立插件 dsh-preset-integrator —— 见 AGENTS 27。）

  // ── 每日 Credits 聚合的持久化 ──────────────────────────────────────
  // 本地 days 来自存活会话的重算：会话删除/重启会丢历史。趋势对比需要
  // 稳定历史，所以每天一行落盘（当天滚动覆盖，历史天只增不减），
  // 同时保留 modeTimeline（前后日均对比的时段边界；开关写入方已随预设迁到
  // dsh-preset-integrator，本插件只读盘里已有的时间线算对比）。

  function dailyCreditsPath() {
    const home = dshHomeDir();
    return home ? `${home.replace(/\/+$/, "")}/${DAILY_CREDITS_REL}` : null;
  }

  /** 把内存里的每日聚合 + 时间线合并落盘（60s 节流；summary 构建时调用）。 */


  /** 读落盘的完整历史（含本地重算覆盖不到的旧天），并算出模式前后日均。 */


  /** 定位 DSH home（daily-credits 落盘目录 `<home>/dsh-mimo-extension/` 的父目录）。 */
  function dshHomeDir() {
    // ① 环境变量（core 进程由应用启动，通常带 DSH_HOME）
    if (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim()) {
      return process.env.DSH_HOME.replace(/\/+$/, "");
    }
    // ② 从插件自身位置向上找名为 `profiles` 的目录，取其父级 ——
    //    无论装在 node_modules 直下还是 pnpm store，都在 dsh-home 之下。
    try {
      let cur = new URL(".", import.meta.url).pathname;
      for (let i = 0; i < 8; i += 1) {
        try {
          if (statSync(`${cur}profiles`).isDirectory()) return cur.replace(/\/+$/, "");
        } catch {}
        const up = cur.replace(/[^/]+\/$/, "");
        if (up === cur) break;
        cur = up;
      }
    } catch {
      /* 忽略 */
    }
    return null;
  }

;


  deps.modelTracker = createModelTracker(ctx, getCounter, () => deps.localCounter, readDefaultModel);

  // ---- 设置持久化（settings.yaml 的 dsh-mimo-extension 命名空间）----
  // 用户在「MiMo 用量」页填写的 Cookie / 套餐总量 / 胶囊位置等存这里，
  // 优先级高于 patch 层 config（config 作为组成基线）。
  let userSettings = null;
  // inject 回调**只传一个 ctx**（官方样例：`inject(["connection","webServer"], (webCtx) => …)`），
  // 服务按属性名从该 ctx 上取 —— 不是按位置传第二个参数。
  ctx.inject(["settings", "configEditor"], (settingsCtx) => {
    // 先抓住 settings 服务：除了注册本插件命名空间，还要用它读
    // `llm-pi-ai` 的 providers.<id>.baseURL（判定计费类型用）。
    settingsService = settingsCtx?.settings ?? null;
    // 0.2 读别人的命名空间只能走 configEditor（见 readNamespaceDoc 的说明）
    try {
      configEditor = settingsCtx?.configEditor ?? null;
    } catch {
      configEditor = null;
    }

    /**
     * 把旧命名空间（`dsh-mimo-extension`）的用户配置迁移到新命名空间
     * （`dsh-mimo-extension`）。
     *
     * **为什么必须做**：插件 2026-09-27 改名，而用户的配置（**含 503 字符的
     * Cookie**、套餐总量、胶囊位置、各开关）都存在旧段落里。直接换名 = 用户
     * 凭空丢配置，且旧段变成没人管的孤儿数据。
     *
     * **读旧段为什么不能走 `get()`**：`settings.get(ns)` 只返回**已注册**命名空间的
     * 解析值，而旧段在新名字下**没有任何插件注册它** → 恒返回 undefined。
     * 所以用 `section(ns)` —— 它读的是**原始文档**（`this.document[ns]`），
     * 不要求注册。⚠ 别改成 `get()`，那样迁移会静默什么都不做。
     *
     * **幂等且单向**：只在「新段为空/无有效字段」且「旧段有内容」时搬一次；
     * 搬完**不删旧段**（留作回滚依据，用户可自行清理）。
     *
     * @returns {Promise<string>} 迁移结果描述（供日志/自检）
     */
    const migrateLegacySettings = async () => {
      const svc = settingsService;
      if (!svc || typeof svc.section !== "function" || typeof svc.update !== "function") {
        return "skip: 设置服务不可用";
      }
      // 新段已有内容 → 不覆盖（用户已经在新名字下配置过）。
      // 这一段必须**先**判，否则链式迁移会拿旧段覆盖用户当前配置。
      let current;
      try {
        current = svc.section(SETTINGS_NS);
      } catch {
        current = undefined;
      }
      const currentMimo = current?.mimo;
      if (currentMimo && typeof currentMimo === "object" && Object.keys(currentMimo).length > 0) {
        return "skip: 新段已有配置（不覆盖）";
      }
      // 链式迁移：按「新→旧」顺序挑第一个有内容的段。三个名字的历史：
      //   dsh-mimo-usage（最早）→ dsh-mimo-extension（上轮）→ mimo-extension（当前，
      //   与 bundle patch 的 id 一致）。任一旧段有配置都要能搬过来。
      let legacy;
      let legacyFrom = null;
      for (const ns of [LEGACY_SETTINGS_NS_FULL, LEGACY_SETTINGS_NS]) {
        try { legacy = svc.section(ns); } catch { legacy = undefined; }
        const m = legacy?.mimo;
        if (m && typeof m === "object" && Object.keys(m).length > 0) { legacyFrom = ns; break; }
        legacy = undefined;
      }
      if (!legacyFrom || !legacy) return "skip: 无旧配置";
      // 本插件在旧段里的实际字段都在 `mimo` 子对象下
      const legacyMimo = legacy.mimo;
      if (!legacyMimo || typeof legacyMimo !== "object" || Object.keys(legacyMimo).length === 0) {
        return "skip: 旧段为空";
      }
      try {
        await svc.update(SETTINGS_NS, { mimo: legacyMimo });
        return `migrated from ${legacyFrom}: ${Object.keys(legacyMimo).join(", ")}`;
      } catch (error) {
        return `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    deps.migrateLegacySettings = migrateLegacySettings;
    try {
      // 真 schemastery 才注册：手写 schema 缺 toJSON 会让 describe() 把整个
      // 设置页一起拖垮（见 buildMimoSettingsSchema 的说明）。
      // 启动时同步一次视觉路由：偏好可能在上次会话里已开启，但那次没能写成
      // （插件重装、或 llm-pi-ai 的 models 后来被改过）。
      // ⚠ 必须放在**注册成功与否之前** —— 视觉路由写的是 `llm-pi-ai` 命名空间，
      // 与本插件自己的命名空间注册（需要 schemastery）**无关**。
      // 放在 register 之后、或放在 `if (!schema) return` 之后，
      // 都会在"拿不到 schemastery"的环境里静默失效（测试抓到过）。
      // 幂等：已经写过就不产生 ops（applyVisionRouting 先比对现状）。
      // schema 优先用真 schemastery（自带 secret 标记与完整元数据）；
      // 拿不到时退到**兜底 schema**，只为让注册成功 ——
      // 注册成功才有写权限，否则连改名迁移都写不进来（见 buildFallbackSettingsSchema）。
      const schema = buildMimoSettingsSchema(settingsCtx) ?? buildFallbackSettingsSchema();
      if (!buildMimoSettingsSchema(settingsCtx)) {
        ctx.logger?.warn?.(
          "[dsh-mimo-extension] 拿不到 @deepseek-ai/schemastery，改用兜底 schema 注册：" +
            "配置仍可读写（含旧命名空间迁移），但设置页里 Cookie 不会被标成密文",
        );
      }
      const scope = (typeof settingsCtx.settings?.register === "function"
        ? settingsCtx.settings.register(SETTINGS_NS, schema, { base: config ?? {} })
        : null);   // 0.2 已移除 settings.register：安全降级到 settingsService.update
      userSettings = scope;
      if (scope && typeof scope.watch === "function") scope.watch(() => {
        deps.clearOfficialCache?.();   // Cookie 改了：官方数据必须重取
      });

      // 「MiMo 模式」预设：按开关安装/移除。
      // 🔴 定义在**这里**（register 之后）而不是 apply 层：
      //    它要读的偏好必须来自**用户层**（`scope.get()`），而 apply 层的
      //    `deps.currentMimo` 赋值在 inject 回调**之后** —— cordis 在服务
      //    已就绪时会**同步执行**本回调，那一刻 deps.currentMimo 还是
      //    undefined → 回退 patch 层 → want 恒 false → **每次重启都会
      //    删掉已安装的预设**（用户实测：预设"出现后又消失"）。
      //    闭包 scope 直接读已注册的解析值，不依赖赋值顺序。

      // 迁移调用**不在这里** —— 见下方独立的 inject 块。
      // 放在这里会有两个坑：
      //   ① 它位于 `if (!schema) return` **之后** → 拿不到 schemastery 时静默失效
      //      （视觉路由踩过同一个坑）；
      //   ② 而且它**必须**在 register 之后（`settings.update` 要求 ns 已注册，
      //      否则直接抛错）—— 两个约束叠在一起，只能解耦。
    } catch (error) {
      ctx.logger?.warn?.("[dsh-mimo-extension] settings 注册失败：%s", error instanceof Error ? error.message : String(error));
    }
  });
  // ── 改名迁移（独立 inject）────────────────────────────────────────────
  //
  // 为什么单独一个 inject 块，而不是塞进上面那个：
  //   · 它需要 settings 服务（读旧段 + 写新段）
  //   · **不能受本插件 schema 注册成败影响** —— 拿不到 schemastery 时，
  //     上面那个块会 `return`，迁移就静默不执行（用户的 Cookie 就"丢了"）
  //   · 而写入又要求命名空间**已注册**，所以必须晚于 register
  // 独立成块后：inject 回调在 settings 就绪时执行，位置在注册块之后，
  // 时序天然满足"先注册、后写"，且与 schema 是否可用无关。
  ctx.inject(["settings"], (migrateCtx) => {
    // 注册块（上方）已在同一轮 inject 中执行；此处额外等一个微任务，
    // 保证 registrations 已就绪（inject 回调按注册顺序同步执行，
    // 但 register 内部用 ctx.effect 登记，给一拍更稳）。
    Promise.resolve()
      .then(() => deps.migrateLegacySettings?.())
      .then((r) => {
        if (r && r.startsWith("migrated")) {
          ctx.logger?.info?.(`[dsh-mimo-extension] 已从旧命名空间迁移配置：${r}`);
        } else if (r && r.startsWith("failed")) {
          ctx.logger?.warn?.(`[dsh-mimo-extension] 配置迁移失败：${r}`);
        }
      })
      .catch(() => {
        /* 迁移失败不影响插件启动 */
      });
  });

      // ── 启动同步（顺序敏感！）──────────────────────────────────────
      // 🔴 **必须在 register 之后**：两个同步都经 `currentMimo()` 读用户层，
      //    而 `userSettings` 要到上面 register 才赋值。放在 register 之前时
      //    currentMimo 回退到 **patch 配置**（里面没有这些开关）→
      //    want 恒为 false → 每次重启都会**删掉已装的 MiMo 模式预设**
      //    （用户实测：预设"出现后又消失"）。
      //    旧版曾要求"视觉同步必须在 schema 判空之前"——那是在引入兜底
      //    schema 之前；现在注册必定发生，顺序以本注释为准。
      deps.syncVisionRouting?.().catch(() => {
        /* 已内部记警告 */
      });
      deps.syncMimoMode?.().catch(() => {
        /* 已内部记警告 */
      });

  /** 用户层设置合并后的 mimo 配置（用户层 > patch config）。 */
  const currentMimo = () => {
    // 🔴 0.2 写读必须**同源**：POST 走 settingsService.update(SETTINGS_NS, …) 写进
    //    loader profile config，所以读也必须读同一条目 —— 旧代码读
    //    `userSettings?.get?.()`，而 0.2 已移除 settings.register（上面 register
    //    调用返回 null）→ userSettings 恒 null → fromUser 恒 {} →
    //    用户保存后**再读恢复原样**（本轮用户实测：提示已保存、重进还原）。
    //    正路与读 llm-pi-ai 一致：configEditor.configuration() 的 inherited。
    //    兜底顺序：configEditor → 旧 userSettings（0.1.x）→ patch config。
    let fromUser = {};
    const viaEditor = readNamespaceDoc(SETTINGS_NS);
    if (viaEditor && typeof viaEditor === "object") fromUser = viaEditor;
    else if (userSettings?.get) {
      try {
        fromUser = userSettings.get() ?? {};
      } catch {
        fromUser = {};
      }
    }
    const merged = mergeConfig(DEFAULT_CONFIG, config ?? {});
    const userMimo = fromUser.mimo ?? {};
    const out = mergeConfig(merged, { mimo: userMimo });
    return out.mimo ?? DEFAULT_CONFIG.mimo;
  };
  deps.currentMimo = currentMimo;

  // 60 秒结果缓存；refresh=1 绕过
  let inflight = null;
  /**
   * summary **不再整体缓存** —— 本地部分（provider/计费/单价/token 计数/UI 偏好）
   * 每次都重算，只有官方三连的成本在 deps.getOfficial 内按 60s 缓存（拆分见其注释）。
   * inflight 仅用于并发去重：多个标签页同时请求时共享一次构建。
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  const getSummary = (signal) => {
    if (inflight) return inflight;
    inflight = buildSummary(deps, signal).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  // ---- web 路由：/api/dsh-mimo-extension/*（软依赖 webServer）----
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
                      // 凭据库是否可用（前端据此决定「安全保存到凭据库」按钮是否可用）
                      vaultAvailable: (() => {
                        try {
                          const c = ctx.get?.("credentials");
                          return Boolean(c && typeof c.set === "function");
                        } catch {
                          return false;
                        }
                      })(),
                      // 凭据引用名（前端展示用；**不是** Cookie 本身）
                      cookieRef: (() => {
                        try {
                          return (typeof mimo.cookieRef === "string" && mimo.cookieRef.trim()) || "MIMO_CONSOLE_COOKIE";
                        } catch {
                          return "MIMO_CONSOLE_COOKIE";
                        }
                      })(),
                      planTotalTokens: m.planTotalTokens ?? 0,
                      // ⚠ 同 result.ui：必须先 deref 再白名单，否则回传 `{}`。
                      pillPosition: pickVolatile(m.pillPosition, PILL_POSITIONS, "header"),
                      wrapToolbar: m.wrapToolbar !== false,
                      hideViewWhenNotMiMo: m.hideViewWhenNotMiMo === true,
                      visionRouting: m.visionRouting === true,
                      visionRoutingTextModels: m.visionRoutingTextModels === true,
                      visionRoutingAllMimo: m.visionRoutingAllMimo === true,
                      billingTypeOverrides: m.billingTypeOverrides ?? {},
                      pricing: m.pricing ?? {},
                      // 0.2：settings.register 可能静默失败（scope 为 null），但 POST
                      // 有 SettingsForms.update 回退通道（见下方 POST 分支）。
                      // writable 必须跟着**写通道**走，否则表单保存按钮被永久禁用
                      // （0.2 实测 writable:false → 界面 disabled）。
                      writable:
                        Boolean(userSettings) ||
                        typeof settingsService?.update === "function",
                      // 登录是否失效 + 失败原因（供界面给「重新登录」引导）。
                      // 从缓存里的官方结果读，不额外打网络。
                      authExpired: officialCache?.authExpired === true,
                      authError: officialCache?.officialError ?? "",
                    },
                  });
                  return;
                }
                if (req.method === "POST" || req.method === "PUT") {
                  // 0.2 适配：`settings.register` 已移除，scope 恒为 null，但写通道
                  // 仍在（settingsService.update，与 dsh-usage-cyanmod 同一修法）。
                  // 只判 userSettings 会在 0.2 下永远报「settings 未装配」。
                  if (!userSettings && typeof settingsService?.update !== "function") {
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
                  if (typeof body.hideViewWhenNotMiMo === "boolean") patch.hideViewWhenNotMiMo = body.hideViewWhenNotMiMo;
                  if (typeof body.visionRouting === "boolean") patch.visionRouting = body.visionRouting;
                  if (typeof body.visionRoutingTextModels === "boolean") patch.visionRoutingTextModels = body.visionRoutingTextModels;
                  if (typeof body.visionRoutingAllMimo === "boolean") patch.visionRoutingAllMimo = body.visionRoutingAllMimo;
                  if (userSettings && typeof userSettings.update === "function") {
                    await userSettings.update({ mimo: patch });
                  } else if (typeof settingsService?.update === "function") {
                    // 0.2：scope 不可用，直接按 ns 写用户层（SettingsForms.update）
                    await settingsService.update(SETTINGS_NS, { mimo: patch });
                  } else {
                    throw new Error("settings 写入通道不可用（0.1.5/0.2 均未命中）");
                  }
                  deps.clearOfficialCache?.();   // 设置已保存：官方数据作废
                  // 视觉路由是**跨命名空间写入**（改的是 llm-pi-ai 的模型声明），
                  // 所以保存后立刻同步一次，并把结果回给界面（失败要能看见原因）。
                  const visionTouched =
                    patch.visionRouting !== undefined || patch.visionRoutingTextModels !== undefined;
                  const vision = visionTouched
                    ? await deps.syncVisionRouting()
                    : { changed: [], error: "" };
                  writeJson(res, 200, {
                    ok: true,
                    data: {
                      saved: Object.keys(patch),
                      visionChanged: vision.changed,
                      visionError: vision.error,
                    },
                  });
                  return;
                }
                writeJson(res, 405, { ok: false, error: "method not allowed" });
                return;
              }

              // 校验一个 Cookie 是否有效（**保存前**先验）。
              // 为什么需要：小米的 Cookie 是浏览器会话产物、会过期，用户粘错一个字符
              // 也看不出来 —— 存进去之后只表现为「一直显示本地估算」。
              // 这里拿候选 Cookie 真打一次官方接口，把结论明确回给界面。
              // ⚠ 只校验**请求里带来的候选值**，不读已存的（那是另一件事）；
              //    也不落盘 —— 校验通过与否由用户决定要不要保存。
              // 把校验通过的 Cookie 写进 **DSH 凭据库**（.credentials.yaml，mode 0600），
              // 而不是明文 settings.yaml —— 这是"尽可能避免泄露"的核心一步。
              //
              // 安全边界（逐条对应风险说明）：
              //   ① 先校验再写：拿候选值真打官方接口，无效直接拒（避免把错值/他人值存下）
              //   ② 只写凭据库：settings 里只留 cookieRef 引用名，**明文不落 settings.yaml**
              //   ③ 不回显：响应体永远只回 {ok, source} —— 绝不回传 Cookie 本身
              //   ④ 仅官方域名：校验只打 DEFAULT_MIMO_API（见 fetchJson 的调用点）
              //   ⑤ 可撤销：unset=true 时用 credentials.unset 删除（用户随时可清除）
              if (url.pathname === ROUTE_PREFIX + "/save-cookie") {
                if (req.method !== "POST") {
                  writeJson(res, 405, { ok: false, error: "只接受 POST" });
                  return;
                }
                const body = await readJsonBody(req);
                const ref = (typeof body?.ref === "string" && body.ref.trim()) || "MIMO_CONSOLE_COOKIE";
                const credentials = ctx.get?.("credentials");
                if (!credentials || typeof credentials.set !== "function") {
                  writeJson(res, 503, {
                    ok: false,
                    error: "凭据服务不可用（本部署未挂载 credentials provider）——请改用设置里的 Cookie 输入框",
                  });
                  return;
                }
                // 撤销路径
                if (body?.unset === true) {
                  try {
                    if (typeof credentials.unset === "function") await credentials.unset(ref);
                    writeJson(res, 200, { ok: true, data: { unset: true, ref } });
                  } catch (error) {
                    writeJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
                  }
                  return;
                }
                const candidate = typeof body?.cookie === "string" ? body.cookie.trim() : "";
                if (!candidate) {
                  writeJson(res, 400, { ok: false, error: "缺少 cookie 字段" });
                  return;
                }
                // ① 先校验（复用官方三连同一判据；失败则不写库）
                const base = (process.env.MIMO_API_URL || DEFAULT_MIMO_API).replace(/\/+$/, "");
                const [okB, rawB] = await fetchJson(`${base}/balance`, candidate);
                const [okD, rawD] = await fetchJson(`${base}/tokenPlan/detail`, candidate);
                const [okU, rawU] = await fetchJson(`${base}/tokenPlan/usage`, candidate);
                const valid = okB || okD || okU;
                if (!valid) {
                  writeJson(res, 200, {
                    ok: true,
                    data: { saved: false, valid: false, error: msgOf(rawB || rawD || rawU).slice(0, 200) },
                  });
                  return;
                }
                // ② 写凭据库（空值会被 provider 拒绝，所以只在 valid 时写）
                try {
                  await credentials.set(ref, candidate);
                } catch (error) {
                  writeJson(res, 500, {
                    ok: false,
                    error: `凭据库写入失败：${String(error?.message ?? error).slice(0, 160)}`,
                  });
                  return;
                }
                // ③ 立刻清官方缓存，让新 Cookie 马上生效（复用既有 clearOfficialCache）
                try {
                  deps.clearOfficialCache?.();
                } catch {
                  /* 缓存清理失败不影响保存结果 */
                }
                // ④ **绝不回显 Cookie** —— 只回引用名与来源标记
                writeJson(res, 200, { ok: true, data: { saved: true, valid: true, ref } });
                return;
              }

              if (url.pathname === ROUTE_PREFIX + "/validate-cookie") {
                if (req.method !== "POST") {
                  writeJson(res, 405, { ok: false, error: "只接受 POST" });
                  return;
                }
                const body = await readJsonBody(req);
                const candidate = typeof body?.cookie === "string" ? body.cookie.trim() : "";
                if (!candidate) {
                  writeJson(res, 400, { ok: false, error: "缺少 cookie 字段" });
                  return;
                }
                const base = (process.env.MIMO_API_URL || DEFAULT_MIMO_API).replace(/\/+$/, "");
                const [okB, rawB] = await fetchJson(`${base}/balance`, candidate);
                const [okD, rawD] = await fetchJson(`${base}/tokenPlan/detail`, candidate);
                const [okU, rawU] = await fetchJson(`${base}/tokenPlan/usage`, candidate);
                // 与"能否读到数据"同一判据：tokenPlan 接口通 = 套餐可用；
                // 仅 balance 通 = 按量账号也有效。两者都失败才算无效。
                const valid = okB || okD || okU;
                const unauthorized = isUnauthorized(rawB) || isUnauthorized(rawD) || isUnauthorized(rawU);
                const plan = okD ? parseTokenPlanDetail(rawD) : null;
                const usage = okU ? parseTokenPlanUsage(rawU) : null;
                writeJson(res, 200, {
                  ok: true,
                  data: {
                    valid,
                    unauthorized,
                    // 能给用户看的简短原因（不含凭据）
                    error: valid ? "" : msgOf(rawB || rawD || rawU).slice(0, 200),
                    planCode: plan?.planCode ?? "",
                    periodEnd: plan?.periodEnd ?? "",
                    limit: usage?.items?.[0]?.limit ?? 0,
                    used: usage?.items?.[0]?.used ?? 0,
                    unit: usage?.unit ?? "",
                  },
                });
                return;
              }
              if (req.method !== "GET") {
                writeJson(res, 405, { ok: false, error: "method not allowed" });
                return;
              }
              if (url.pathname === ROUTE_PREFIX + "/summary") {
                const force = url.searchParams.get("refresh") === "1";
                const payload = force ? await buildSummary(deps, undefined, { refreshOfficial: true }) : await getSummary();
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
      "dsh-mimo-extension: /api routes",
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


// ── 0.2 静态 Config 导出 ─────────────────────────────────────────────
// 0.2 的设置系统从 `entry.fiber.runtime.Config` 读取 schema（schemastery，
// 必须带 toJSON）；没有它 describe 会静默跳过本 ns、自动生成的设置页不会
// 出现、旧配置迁移也会被拒。锚点走插件自身位置（上链 profile/node_modules，
// 部署环境必有 @deepseek-ai/schemastery）。
let __staticConfig;
try {
  const __S = loadSchemaFactory({ baseUrl: (() => {
    // 0.2 Config 的 schemastery 解析锚点（修复）：host.js 位于
    //   <profiles>/<profile>/node_modules/<pkg>/host.js
    // 而 schemastery 在**回退层** `<profiles>/node_modules/` 里 —— Node 的解析
    // 不会从 `<profile>/node_modules` 跨到上一级 `<profiles>/node_modules`，
    // 所以 `../../`（= <profile>/）永远找不到它，Config 退化成 undefined，
    // 进而 describe() 静默跳过该 ns、save 报「No configurable plugin entry」。
    // 这里按层级逐个尝试，命中即用。
    for (const up of ["../../../", "../../../../", "../../"]) {
      try {
        const url = new URL(up, import.meta.url).href;
        const probe = createRequire(url)("@deepseek-ai/schemastery/package.json");
        if (probe) return url;
      } catch { /* 换下一层 */ }
    }
    return new URL("../../../", import.meta.url).href;
  })() });
  if (__S) __staticConfig = buildMimoSettingsSchema(__S);
} catch { /* schemastery 不可用时退化为无设置页 */ }
export const Config = __staticConfig;

// 0.2 关键（修复「保存失败：设置服务不可用」）：Cordis 的 `unwrapExports` 在模块
// **有 default 导出**时只返回 default（loader: `exports = exports.default ?? exports`），
// 而 `plugin.Config` 是从这个返回值上读的 —— 只写 `export const Config` 会在
// unwrap 后被丢掉 ⇒ `runtime.Config === undefined` ⇒ `settings.describe()` 静默
// 跳过本 ns、设置页不出现、保存报「No configurable plugin entry」。
// 把 Config 同时挂到 default 导出的函数对象上，unwrap 后仍能读到。
try { apply.Config = __staticConfig; } catch { /* 极端情况忽略 */ }
export default apply;
