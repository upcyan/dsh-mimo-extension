/**
 * dsh-mimo-usage 自检脚本
 *
 * 无需 react / 浏览器：静态扫描 + 用忠实模拟 Cordis 上下文的 Proxy 调用 apply，
 * 专门抓住「访问未 inject 的服务属性」这类只在真实宿主里才暴露的 bug。
 *
 * 用法： node check.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const fail = [];
const pass = [];
const ok = (cond, msg) => (cond ? pass.push(msg) : fail.push(msg));

/** 从 profile（含指向 core 的软链树）解析 dsh 自己的依赖，锚点可被环境变量覆盖。
 *  解析顺序：`CHECK_PROFILE` → `$DSH_HOME/profiles/web` → 当前目录（源码仓库直接跑时）。 */
const coreRequire = createRequire(
  (process.env.CHECK_PROFILE ??
    (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web` : process.cwd())) + "/__anchor__.js",
);

// ---------- 1. 文件与清单一致性 ----------
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

for (const rel of pkg.files ?? []) {
  ok(existsSync(join(here, rel)), `files 声明的 ${rel} 存在`);
}
const clientExport = pkg.exports?.["./client"];
ok(typeof clientExport === "string" && existsSync(join(here, clientExport)), `exports["./client"] 指向的文件存在 (${clientExport})`);
ok(pkg.dsh?.bundle?.patch !== undefined && existsSync(join(here, pkg.dsh.bundle.patch)), "dsh.bundle.patch 指向的文件存在");
ok(pkg.dsh?.client?.platform === "web", "dsh.client.platform 为 web");
ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, "dsh.client.inject 已声明（决定 boot graph 加载顺序）");

// ---------- 2. cordis.patch.yml 结构（缩进/键名） ----------
const patchText = readFileSync(join(here, "cordis.patch.yml"), "utf8");
let patch;
try {
  const yaml = await import("yaml").catch(() => null);
  patch = yaml ? yaml.parse(patchText) : null;
  if (patch) pass.push("cordis.patch.yml 可被 YAML 解析");
} catch (error) {
  fail.push(`cordis.patch.yml 解析失败：${error.message}`);
}
if (patch) {
  const row = patch?.[0]?.insert?.[0];
  ok(row?.id === "mimo-usage", "patch insert.id 为 mimo-usage");
  ok(row?.name === "dsh-mimo-usage", "patch insert.name 为 dsh-mimo-usage");
  ok(row?.config?.mimo !== undefined, "patch 携带 config.mimo");
  // 缩进塌陷会让 mimo 变成字符串或丢失，这里显式确认嵌套结构
  ok(typeof row?.config?.mimo === "object" && row.config.mimo !== null, "config.mimo 是对象（缩进未塌陷）");
  ok(row?.config?.mimo?.planTotalTokens === 500000000, "config.mimo.planTotalTokens 数值正确");
  ok(row?.config?.mimo?.pricing?.fallbackPrice?.input === 0, "config.mimo.pricing.fallbackPrice 嵌套完整");
}

// ---------- 3. host.js 加载与注册 ----------
const host = await import(join(here, "host.js"));
ok(typeof host.apply === "function", "host.js 导出 apply");
ok(host.name === "mimo-usage", "host 插件名为 mimo-usage");
ok(Array.isArray(host.inject), "host 声明 inject");

// ---------- 4. client.js：用“会抛错的 Proxy”模拟 Cordis ----------
/**
 * 构造忠实模拟 Cordis 的上下文。
 * 关键：读取未声明 inject 的服务属性必须抛错，而不是返回 undefined
 * —— 这正是 `cannot get property "x" without inject` 的成因。
 */
function makeCordisLikeCtx(declaredInject, { onRegister } = {}) {
  const services = new Map();
  const registered = [];
  const state = { localeRegistered: 0, effectCount: 0 };

  const slots = {
    inject: (name, factory) => {
      services.set(name, true);
      const entry = factory();
      registered.push({ slot: name, options: entry.options });
      onRegister?.(name, entry);
      return () => {};
    },
    register: (options, component) => ({ options, component }),
  };
  const locale = {
    register: () => {
      state.localeRegistered += 1;
      return () => {};
    },
    bind: () => (key, params) => {
      let s = key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
  };
  services.set("slots", slots);
  services.set("locale", locale);

  const target = {
    slots,
    locale,
    effect: () => {
      state.effectCount += 1;
      return () => {};
    },
    inject: (names, fn) => {
      // Cordis 的 ctx.inject([...]) 用于可选依赖；声明后回调内可读。
      // 这里的 scope 只继承「当前上下文的 declaredInject + 本次 names」，
      // 因此若调用方漏声明 locale，回调内读 ctx.locale 仍会抛错
      // —— 这正是负向验证要覆盖的行为。
      const scope = makeCordisLikeCtx([...declaredInject, ...names], { onRegister });
      return fn(scope);
    },
    fiber: { entry: { options: { name: "dsh-mimo-usage" } } },
  };

  return {
    ...new Proxy(target, {
      get(t, prop, recv) {
        if (typeof prop === "symbol" || prop === "then" || prop.startsWith("_")) return Reflect.get(t, prop, recv);
        if (prop in t) return Reflect.get(t, prop, recv);
        if (!declaredInject.includes(prop)) {
          // 与 Cordis ReflectService.handler 的行为一致
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        }
        return services.get(prop);
      },
      has(t, prop) {
        return prop in t || declaredInject.includes(prop);
      },
    }),
    __state: state,
    __registered: registered,
  };
}

const clientSource = readFileSync(join(here, "client.js"), "utf8");
let loaded = null;
const fakeWindow = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded = entry;
    },
  },
};
const realWindow = globalThis.window;
globalThis.window = fakeWindow;
try {
  // client.js 是 CJS-ish 工厂包，用 Function 包一层模拟
  const module = { exports: {} };
  const factoryWrapper = new Function("module", "exports", "require", clientSource);
  factoryWrapper(module, module.exports, () => {
    throw new Error("unexpected require during load");
  });
} catch (error) {
  fail.push(`client.js 顶层执行失败：${error.message}`);
}
globalThis.window = realWindow;
ok(loaded !== null, "client.js 调用了 __ModuleLoader__.load");
ok(loaded?.id === "dsh-mimo-usage", "client bundle id 为 dsh-mimo-usage");

if (loaded) {
  // 用假 react 构造模块（不需要真实 react）
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  };
  let mod;
  try {
    mod = loaded.factory((name) => {
      if (name === "react") return fakeReact;
      throw new Error(`client.js 请求了未声明的外部模块 "${name}"（需在 dsh.client.external 中声明）`);
    });
    pass.push("client factory 可在仅依赖 react 的情况下物化");
  } catch (error) {
    fail.push(`client factory 物化失败：${error.message}`);
  }

  if (mod) {
    ok(typeof mod.apply === "function", "client 导出 apply");
    const declared = Array.isArray(mod.inject) ? mod.inject : [];
    ok(declared.includes("slots"), "client inject 含 slots");
    ok(declared.includes("locale"), "client inject 含 locale（apply 会读取 ctx.locale）");

    // 关键回归：用会抛错的 Proxy 调 apply
    const ctx = makeCordisLikeCtx(declared);
    try {
      mod.apply(ctx);
      pass.push("apply() 在 Cordis 式上下文下执行成功（无未 inject 的服务访问）");
    } catch (error) {
      fail.push(`apply() 抛错：${error.message}`);
    }
    const slots = ctx.__registered.map((r) => r.slot);
    ok(slots.includes("conversation.session.header.actions"), "注册了会话头部胶囊槽位（默认位置）");
    ok(slots.includes("conversation.view"), "注册了详情页视图槽位");
    const pill = ctx.__registered.find((r) => r.slot.includes("header.actions"))?.options;
    const view = ctx.__registered.find((r) => r.slot === "conversation.view")?.options;
    ok(pill?.order === 30, "胶囊 order=30（排在对话/轨迹之后）");
    ok(pill?.id === "mimo-usage-pill", "胶囊 id 正确");
    ok(view?.id === "mimo-usage", "视图 id=mimo-usage");
    ok(view?.order === 15, "视图 order=15（轨迹之后、额度之前）");

    // 胶囊可选位置：三处槽位映射必须都在源码中就位（运行时按偏好迁移）
    const seatExpect = [
      ["header", "conversation.session.header.actions"],
      ["toolbar", "conversation.input.right"],
      ["above", "conversation.composer.dock"],
    ];
    for (const [name, slot] of seatExpect) {
      const re = new RegExp(`${name}:\\s*\\{\\s*slot:\\s*"${slot.replace(/\./g, "\\.")}"`);
      ok(re.test(clientSource), `胶囊位置 ${name} → ${slot}`);
    }
    ok(/pillPosition/.test(clientSource), "胶囊位置偏好已接入（pillPosition）");
    ok(/wrapToolbar/.test(clientSource) && /applyToolbarWrap/.test(clientSource), "工具栏自动换行开关已实现（wrapToolbar）");
    ok(/useViewport/.test(clientSource) && /narrow/.test(clientSource), "移动端窄屏适配已实现（useViewport → narrow）");
    ok(/MimoSettingsForm/.test(clientSource), "详情页内嵌配置表单已实现（MimoSettingsForm）");

    // 路由前缀必须避开 /api/*：DSH 核心对 /api 前缀做严格 Origin===Host 校验，
    // 经 fnOS 网关访问时会 403，导致设置页无法保存。
    const hostSrc = readFileSync(join(here, "host.js"), "utf8");
    ok(/const ROUTE_PREFIX = "\/dsh-mimo-usage"/.test(hostSrc), "宿主路由前缀为 /dsh-mimo-usage（避开 /api）");
    ok(!/path: "\/api\/dsh-mimo-usage"/.test(hostSrc), "宿主未使用 /api/dsh-mimo-usage（会被核心拦截）");
    ok(/`\$\{ROUTE_PREFIX\}\/\$\{endpoint\}`/.test(clientSource), "客户端请求 /dsh-mimo-usage/*（与宿主前缀一致）");
    ok(!clientSource.includes("/api/dsh-mimo-usage"), "客户端未残留 /api/dsh-mimo-usage 路径");
    ok(/x-forwarded-host/.test(hostSrc), "isTrusted 容忍网关改写的 Host（X-Forwarded-Host）");

    // fnOS 网关前缀自适应（方案 A）：平台把页面挂在 /app/dsh-fnos/dsh/ 下并注入
    // globalThis.__FNOS_GATEWAY_PREFIX__；绝对路径不受 <base href> 影响，
    // 插件必须自己补前缀，否则经网关访问 POST 落进 frontend-static 的
    // fallback 得到 405 空响应 / GET 得到 404。
    ok(/function gatewayPath\(/.test(clientSource), "客户端定义了 gatewayPath（网关前缀自适应）");
    ok(/__FNOS_GATEWAY_PREFIX__/.test(clientSource), "客户端读取 __FNOS_GATEWAY_PREFIX__");
    ok(/gatewayPath\(`\$\{ROUTE_PREFIX\}\/\$\{endpoint\}`\)/.test(clientSource), "rpc() 的 URL 经 gatewayPath 补前缀");
    ok(/gatewayPath\(`\$\{ROUTE_PREFIX\}\/ping`\)/.test(clientSource), "诊断回传经 gatewayPath 补前缀（每次发送时求值）");
    // 直连 3081 时前缀缺失，必须退化为空串而不是报错
    {
      // ⚠ 不能用 indexOf("\n}") 找函数结尾：IIFE 包裹后内层缩进会先匹配到。
      // 改成大括号配对，对缩进变化免疫。
      const extractFn = (src, signature) => {
        const i = src.indexOf(signature);
        if (i < 0) return null;
        let j = src.indexOf("{", i);
        let depth = 0;
        let inStr = null;
        let esc = false;
        for (let k = j; k < src.length; k++) {
          const c = src[k];
          if (inStr !== null) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === inStr) inStr = null;
            else if (inStr === "`" && c === "$" && src[k + 1] === "{") depth++;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
          if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) return src.slice(i, k + 1);
          }
        }
        return null;
      };
      const fnBody = extractFn(clientSource, "function gatewayPath(path)");
      ok(fnBody !== null, "能提取 gatewayPath 函数体（大括号配对，缩进不敏感）");
      const gw = new Function(`${fnBody}\nreturn gatewayPath;`)();
      const saved = globalThis.__FNOS_GATEWAY_PREFIX__;
      try {
        delete globalThis.__FNOS_GATEWAY_PREFIX__;
        ok(gw("/dsh-mimo-usage/ping") === "/dsh-mimo-usage/ping", "无前缀环境下路径保持不变（直连 3081）");
        globalThis.__FNOS_GATEWAY_PREFIX__ = "/app/dsh-fnos/dsh";
        ok(gw("/dsh-mimo-usage/ping") === "/app/dsh-fnos/dsh/dsh-mimo-usage/ping", "有前缀环境下正确拼接（经网关 3080）");
        globalThis.__FNOS_GATEWAY_PREFIX__ = "/app/dsh-fnos/dsh/";
        ok(gw("/dsh-mimo-usage/ping") === "/app/dsh-fnos/dsh/dsh-mimo-usage/ping", "前缀带尾部斜杠时不拼出双斜杠");
        globalThis.__FNOS_GATEWAY_PREFIX__ = "";
        ok(gw("/dsh-mimo-usage/ping") === "/dsh-mimo-usage/ping", "空前缀退化为无前缀");
      } finally {
        if (saved === undefined) delete globalThis.__FNOS_GATEWAY_PREFIX__;
        else globalThis.__FNOS_GATEWAY_PREFIX__ = saved;
      }
    }

    // 第 7 个线上 bug 的回归：**顶层作用域污染**。
    // 平台把整批插件的 client.js 拼成一个 <script>，共享顶层作用域；
    // 多个插件都声明顶层 `function makeFactory` 时函数声明提升会互相覆盖，
    // 导致 load({factory: makeFactory}) 拿到别人的工厂 → 本插件整片失效。
    // 因此本模块必须整体包在 IIFE 里，不得有任何顶层声明。
    {
      const topLevel = clientSource
        .split("\n")
        .map((line, idx) => ({ line, idx: idx + 1 }))
        .filter(({ line }) => /^(?:function|const|let|var|window\.|globalThis\.)/.test(line));
      ok(
        topLevel.length === 0,
        `client.js 无顶层声明（IIFE 隔离；实测 ${topLevel.length} 处违规${
          topLevel.length ? "：" + topLevel.map((t) => `L${t.idx}`).join(",") : ""
        }）`,
      );
      ok(/^\(function \(\) \{/m.test(clientSource), "模块体以 IIFE 开头（防跨插件同名覆盖）");
      ok(/\}\)\(\);\s*$/.test(clientSource.trimEnd()), "模块体以 })(); 正确闭合");
      // 同名覆盖的正面证据：这些顶层名字绝不能出现在作用域顶层
      for (const name of ["makeFactory", "gatewayPath", "probe", "sendPing"]) {
        const re = new RegExp(`^(?:function|const|let|var) ${name}\\b`, "m");
        ok(!re.test(clientSource), `顶层未声明 ${name}（避免与兄弟插件冲突）`);
      }
    }

    // isTrusted 行为回归：反代必须放行，跨站必须拒绝。
    // 用真实函数体求值，覆盖 fnOS nginx 改写 Host 的场景。
    const trustCheck = (() => {
      const i = hostSrc.indexOf("function isTrusted(req) {");
      if (i < 0) return ["未找到 isTrusted"];
      const end = hostSrc.indexOf("\n}\n", i);
      const body = hostSrc.slice(i + "function isTrusted(req) {".length, end);
      let fn;
      try {
        fn = new Function("req", body);
      } catch (error) {
        return [`isTrusted 无法求值：${error.message}`];
      }
      const cases = [
        // [headers, 期望, 说明]
        [{ origin: "https://example.fnos.net", host: "localhost", "sec-fetch-site": "same-origin" }, true, "反代(浏览器 same-origin)"],
        [{ origin: "http://192.168.1.9:5666", host: "192.168.1.9:5666", "sec-fetch-site": "same-origin" }, true, "内网同源"],
        [{ origin: "https://example.fnos.net", host: "localhost" }, true, "反代无 Sec-Fetch"],
        [{ origin: "http://127.0.0.1:13080" }, true, "本机直连"],
        [{}, true, "无 Origin"],
        [{ origin: "http://evil.example", host: "localhost", "sec-fetch-site": "cross-site" }, false, "跨站"],
        [{ origin: "http://evil.example", host: "localhost" }, false, "外部域名"],
        [{ origin: "nonsense", host: "localhost" }, false, "Origin 非法"],
      ];
      const bad = [];
      for (const [headers, expect, label] of cases) {
        let got;
        try {
          got = fn({ headers });
        } catch (error) {
          bad.push(`${label}(抛错)`);
          continue;
        }
        if (got !== expect) bad.push(`${label}(期望${expect ? "放行" : "拒绝"}得${got ? "放行" : "拒绝"})`);
      }
      return bad;
    })();
    ok(trustCheck.length === 0, `isTrusted 反代放行 / 跨站拒绝（问题: ${trustCheck.join(", ") || "无"}）`);

    // Hooks 规则：hook 不得出现在「提前 return」之后（会导致 React 崩溃）。
    //
    // 难点是要区分三类 return：
    //   1. 组件的输出 return（4 空格缩进）      —— 基准，不是提前返回
    //   2. 提前 return（`if (…) { return … }`，6 空格）—— 真正的分水岭
    //   3. 回调内的 return（useMemo/useEffect 内部，缩进 ≥6 空格）—— 必须忽略
    //
    // 因此按「缩进 + 是否位于组件体一级块」判定：只有缩进恰为 6 空格、
    // 且其上方最近的 4 空格语句是 if/else 块开头的 return 才算提前返回。
    // 简化实现：取「所有 4 或 6 空格缩进的 return」中最靠前者作为分水岭，
    // 但要求它前面没有未闭合的回调 —— 通过检查 return 之前的 4 空格行里
    // 是否出现 `=> {` 且未配对来排除回调。
    const hookCheck = (() => {
      const lines = clientSource.split("\n");
      const problems = [];
      const fnStarts = [];
      lines.forEach((ln, i) => {
        const m = /^ {2}function ([A-Z]\w*)\(/.exec(ln);
        if (m) fnStarts.push({ name: m[1], line: i });
      });
      const indentOf = (ln) => (ln.match(/^ */) ?? [""])[0].length;
      for (let k = 0; k < fnStarts.length; k += 1) {
        const { name, line: start } = fnStarts[k];
        const end = k + 1 < fnStarts.length ? fnStarts[k + 1].line : lines.length;
        const body = lines.slice(start, end);

        // 找组件的输出 return（4 空格）。它就是主体渲染，不算提前返回。
        const outputReturn = body.findIndex((ln) => /^ {4}return\b/.test(ln));

        // 找提前 return：缩进 6 空格，且上一非空行是 `if (...) {` 或 `} else {`
        let earlyReturn = -1;
        for (let i = 0; i < body.length; i += 1) {
          const ln = body[i];
          if (!/^ {6}return\b/.test(ln)) continue;
          // 往上找最近的 `{` 起始行，若为 if/else 块则视为提前返回
          for (let j = i - 1; j >= 0 && j > i - 12; j -= 1) {
            const prev = body[j];
            if (/^ {4}\}?\s*else\s*\{/.test(prev) || /^ {4}if\s*\(.*\{\s*$/.test(prev) || /^ {4}\}\s*else\s+if\s*\(.*\{\s*$/.test(prev)) {
              earlyReturn = i;
              break;
            }
            if (/^ {4}\S/.test(prev) && !/^ {4}\}/.test(prev)) break;
          }
          if (earlyReturn >= 0) break;
        }
        if (earlyReturn < 0) continue; // 无提前返回 → 无需检查

        const after = body
          .map((ln, i) => ({ ln, i }))
          .filter(({ ln, i }) => i > earlyReturn && /^ {4}\S/.test(ln) && /\buse[A-Z]\w*\(/.test(ln));
        if (after.length > 0) {
          problems.push(`${name}（第 ${after.map((x) => start + x.i + 1).join(",")} 行）`);
        }
        void outputReturn;
      }
      return problems;
    })();
    ok(hookCheck.length === 0, `组件 Hook 顺序合规（提前 return 之后不得有 hook；问题: ${hookCheck.join("; ") || "无"}）`);

    // 静态检查：源码里访问了哪些 ctx.<service>，必须都在 exports.inject 中声明。
    // 这比运行期负向验证更可靠 —— bindLocale 内的 try/catch 会吞掉运行期报错。
    const declaredList = (clientSource.match(/exports\.inject\s*=\s*\[([^\]]*)\]/)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    // 出现在 ctx.<name> 里的名字，排除 Cordis 基础能力（非服务，无需 inject）
    const BASE_CTX = new Set(["get", "on", "inject", "effect", "fiber", "scope", "logger", "set", "provide", "waterfall", "parallel", "emit", "start", "stop",
      // Cordis 上下文自身的属性，不是服务：loadSchemaFactory 用它当模块解析锚点
      "baseUrl", "base", "name", "sid"]);
    /**
     * 先剥掉注释再扫描：注释里作为说明出现的 `ctx.settings` 不是真实访问。
     * 块注释与行注释都处理（行注释不误伤 `http://` 这类前缀）。
     */
    const stripComments = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const accessed = new Set(
      [...stripComments(clientSource).matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]).filter((n) => !BASE_CTX.has(n)),
    );
    const undeclared = [...accessed].filter((n) => !declaredList.includes(n));
    ok(undeclared.length === 0, `client.js 访问的服务均已声明 inject（访问: ${[...accessed].join(", ") || "无"}；未声明: ${undeclared.join(", ") || "无"}）`);

    // 同类静态检查也覆盖 host.js（宿主侧 apply 更严格，访问未 inject 的服务会直接崩）
    const hostSource = readFileSync(join(here, "host.js"), "utf8");
    const hostDeclared = new Set([
      // 顶层 export const inject = [...]
      ...[...(hostSource.match(/export const inject\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").split(",")],
      // ctx.inject(["x"], ...) 形式声明的可选依赖
      ...[...hostSource.matchAll(/ctx\.inject\(\s*\[([^\]]*)\]/g)].flatMap((m) => m[1].split(",")),
    ].map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    const hostAccessed = new Set(
      [...stripComments(hostSource).matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]).filter((n) => !BASE_CTX.has(n)),
    );
    const hostUndeclared = [...hostAccessed].filter((n) => !hostDeclared.has(n));
    ok(hostUndeclared.length === 0, `host.js 访问的服务均已声明 inject（未声明: ${hostUndeclared.join(", ") || "无"}）`);
  }
}

// ---------- 5. 设置 schema：describe() 不能抛、cookie 必须被 redact ----------
//
// 这一段是针对 MEMORY.md §三那条根因的回归测试：
// 手写 schema 没有 toJSON → dsh-settings 的 describe() 在 `.map()` 里裸调
// `registration.schema.toJSON()` → 所有命名空间的 describe 一起抛错 →
// 设置 → 插件页整体拿不到数据（殃及 prompt-manager 等其它插件）。
{
  const profileUrl =
    process.env.DSH_PROFILE_URL ??
    pathToFileURL(
      (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web` : process.cwd()) + "/",
    ).href;
  const schema = host.buildMimoSettingsSchema({ baseUrl: profileUrl });

  if (!schema) {
    fail.push(
      "buildMimoSettingsSchema() 返回 undefined（拿不到 schemastery）。" +
        "这会让本插件配置在 GUI 中退化为只读 —— 若 profile 路径不同，" +
        "用 DSH_PROFILE_URL=file:///path/to/profiles/web/ 重跑。",
    );
  } else {
    ok(typeof schema === "function", "设置 schema 可调用（resolve() 的硬要求）");

    // 1) describe() 的硬要求
    let json = null;
    try {
      json = schema.toJSON();
      ok(json !== null && typeof json === "object", "schema.toJSON() 返回对象（describe() 的硬要求）");
    } catch (error) {
      fail.push(`schema.toJSON() 抛错：${error.message}`);
    }
    ok(schema.type === "object", "schema.type === 'object'（redactSecrets 遍历用）");
    ok(
      schema.dict?.mimo?.dict?.cookie?.meta?.role === "secret",
      "cookie 标记为 role:'secret'（明文不得随 describe 过线）",
    );
    ok(typeof schema.dict?.mimo?.dict?.pricing?.inner !== "undefined" || schema.dict?.mimo?.dict?.pricing?.type === "dict",
      "pricing 为 dict 结构（动态键可遍历）");

    // 2) 脏输入不得抛错：register() 的 resolve 路径会立即调用 schema
    try {
      const value = schema({ mimo: { planTotalTokens: "abc", pillPosition: "nope", cookie: "SECRET-COOKIE" } });
      ok(value?.mimo?.planTotalTokens === 500000000, `脏输入回落默认值（planTotalTokens=${value?.mimo?.planTotalTokens}）`);
      ok(value?.mimo?.pillPosition === "header", `非法 pillPosition 回落 header（实为 ${value?.mimo?.pillPosition}）`);

      // 3) 走**真实的** dsh-settings.describe() —— 这正是当年抛错的代码路径。
      //    直接用它导出的 SettingsProvider.prototype，跳过整个 Cordis 装配。
      let SettingsProvider;
      try {
        ({ SettingsProvider } = coreRequire("@deepseek-ai/dsh-settings"));
        ok(typeof SettingsProvider === "function", "加载到真实 @deepseek-ai/dsh-settings");
      } catch (error) {
        fail.push(`无法加载 @deepseek-ai/dsh-settings：${error.message}`);
      }
      if (SettingsProvider) {
        const makeStub = (ns, sch) => {
          const stub = Object.create(SettingsProvider.prototype);
          stub.registrations = new Map([
            [ns, { ns, schema: sch, base: undefined, resolved: sch(value), revision: 0, applies: "live" }],
          ]);
          return stub;
        };
        try {
          const [descriptor] = makeStub("dsh-mimo-usage", schema).describe({ redactSecrets: true });
          ok(descriptor && typeof descriptor.schema === "object",
            "真实 describe() 未抛错（schema.toJSON 可用）");
          ok(!JSON.stringify(descriptor.value).includes("SECRET-COOKIE"),
            "真实 describe(redactSecrets) 已剥离 cookie 明文");
          ok(
            (descriptor.secrets ?? []).some((s) => s.path.join(".") === "mimo.cookie" && s.set === true),
            `secrets 槽位记录 mimo.cookie 已设值（${(descriptor.secrets ?? []).map((s) => s.path.join(".")).join(", ") || "无"}）`,
          );
        } catch (error) {
          fail.push(`真实 describe() 抛错：${error.message}`);
        }

        // 负向对照：无 toJSON 的手写函数确实会让 describe() 抛错 ——
        // 证明上面这几条断言**能**抓住原始 bug，而不是恒真。
        const plain = (input) => input;
        plain.type = undefined;
        try {
          makeStub("legacy", plain).describe({ redactSecrets: true });
          fail.push("负向对照失效：手写 schema 居然通过了 describe()（测试不再有效）");
        } catch {
          ok(true, "负向对照：无 toJSON 的手写 schema 会让 describe() 抛错（原始 bug 可被本测试抓住）");
        }
      }
    } catch (error) {
      fail.push(`schema 对脏输入抛错：${error.message}`);
    }

    // 4) 源码级回归：不能再把无 toJSON 的手写函数注册进去
    const hostSource = readFileSync(join(here, "host.js"), "utf8");
    ok(
      !/register\(\s*SETTINGS_NS\s*,\s*mimoSettingsSchema\b/.test(hostSource),
      "未把手写函数直接注册进 settings（那是 describe() 抛错的根因）",
    );
    ok(/buildMimoSettingsSchema\(/.test(hostSource), "注册路径使用 buildMimoSettingsSchema()");
    ok(/跳过设置命名空间注册/.test(hostSource), "拿不到 schemastery 时跳过注册（而非注册残缺 schema）");
  }
}

// ---------- 6. 三个线上问题的回归 ----------
{
  // (a) 官方 percent 是 0~1 的**比值**，不是百分数。
  //     实测 payload（2026-09-25）：used/limit = 0.096038 → percent 0.096 → 应显示 9.6%。
  //     直接把 0.096 当百分数显示 = 只有真实值的 1/100（用户报的「本月已用不对」）。
  const realUsage = {
    code: 0,
    data: {
      monthUsage: {
        percent: 0.096,
        items: [{ name: "month_total_token", used: 4725102737, limit: 49200000000, percent: 0.096 }],
      },
      usage: {
        percent: 0.1,
        items: [
          { name: "plan_total_token", used: 4725102737, limit: 49200000000, percent: 0.1 },
          { name: "compensation_total_token", used: 0, limit: 0, percent: 0 },
        ],
      },
    },
  };
  const pct = host.toPercent(0.096, 4725102737, 49200000000);
  ok(pct === 9.6, `toPercent 把比值 0.096 换算成 9.6%（实得 ${pct}）`);
  ok(host.toPercent(1.5, 0, 0) === 1.5, "toPercent 兼容已是百分数的响应（n>1 不再乘 100）");
  ok(host.toPercent(undefined, 50, 200) === 25, "percent 缺失时用 used/limit 兜底");
  ok(host.toPercent(0, 0, 0) === 0, "全零 → 0");
  const parsed = host.parseTokenPlanUsage(realUsage);
  ok(parsed?.percent === 9.6, `parseTokenPlanUsage 顶层 percent = 9.6（实得 ${parsed?.percent}）`);
  ok(parsed?.items?.[0]?.percent === 9.6, `items[0].percent = 9.6（实得 ${parsed?.items?.[0]?.percent}）`);
  ok(parsed?.extra?.[0]?.percent === 10, `extra[0].percent 与控制台同口径 = 10（实得 ${parsed?.extra?.[0]?.percent}）`);
  ok(parsed?.unit === "Credits", "Token Plan 单位是 Credits");
  ok(!/"percent":0\.096/.test(JSON.stringify(parsed)), "结果里不得残留 0~1 比值口径的 percent");

  // (b) token-usage 目录不存在 ≠ 故障（dsh-token-usage-counter 未装时目录本来就没有）
  const st = await host.aggregateLocalUsage(`/nonexistent-dsh-home-${Date.now()}`);
  ok(st.ok === true && st.error === "" && st.missing === true,
    `目录缺失按「暂无记录」处理（ok=${st.ok}, error=${st.error || "无"}, missing=${st.missing}）`);
  ok(Array.isArray(st.days) && st.days.length === 0, "目录缺失时 days 为空数组（不抛错）");

  // (c) 计数器缺席时会话 token 用量不能恒为 0
  const now = Date.now();
  const events = [
    { type: "request/header", seq: 1, time: now, data: { header: { config: { provider: "mimo", model: "mimo-v2.6-flash" } } } },
    { type: "assistant/message", seq: 2, time: now, data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, totalTokens: 1150 } } },
    {
      type: "assistant/message",
      seq: 3,
      time: now,
      data: {
        message: { source: { provider: "mimo", model: "mimo-v2.6-flash" } },
        usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 500, totalTokens: 550 },
      },
    },
  ];
  const session = { id: "sess-1", snapshotEvents: () => events };
  const fakeCtx = {
    get: (name) =>
      name === "sessions"
        ? { list: () => [session], get: (id) => (id === "sess-1" ? session : undefined) }
        : undefined,
  };
  const local = host.createLocalUsageCounter(fakeCtx);
  const first = local.getSession("sess-1");
  ok(first?.counters?.totalTokens === 1700,
    `内置统计算出会话 1700 tokens（实得 ${first?.counters?.totalTokens}）`);
  ok(first?.calls === 2 && first?.models?.length === 1 && first?.models?.[0]?.provider === "mimo",
    "内置统计按 provider/model 归组（calls/models 正确）");

  // 重复扫描（/session 每 60s 一次）必须靠 seq 去重，不得翻倍
  local.getSession("sess-1");
  local.snapshot();
  local.usageStats();
  const again = local.getSession("sess-1");
  ok(again?.counters?.totalTokens === 1700, `重复扫描不重复计数（实得 ${again?.counters?.totalTokens}）`);

  const payload = host.sessionUsagePayload(null, local, "sess-1");
  ok(payload?.totalTokens === 1700 && payload?.source === "session-events",
    `/session 在计数器缺席时返回 1700 tokens（实得 ${payload?.totalTokens}, source=${payload?.source}）`);

  // 计数器装回来后必须以它为准（内置统计只是回退，不能反过来盖掉权威数据）
  const realCounter = {
    getSession: (id) =>
      id === "sess-1"
        ? { counters: { totalTokens: 9999, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 }, calls: 5, models: [] }
        : null,
  };
  const preferReal = host.sessionUsagePayload(realCounter, local, "sess-1");
  ok(preferReal?.totalTokens === 9999 && preferReal?.source === "token-usage-counter",
    `计数器有数据时优先用它（total=${preferReal?.totalTokens}, source=${preferReal?.source}）`);
  const noRealRecord = host.sessionUsagePayload({ getSession: () => null }, local, "sess-1");
  ok(noRealRecord?.totalTokens === 1700,
    `计数器没有该会话时回退到内置统计（total=${noRealRecord?.totalTokens}）`);
  ok(host.sessionUsagePayload(null, local, "no-such-session") === null, "未知会话返回 null");
  ok(host.sessionUsagePayload(null, null, "sess-1") === null, "两个数据源都缺失时返回 null（不抛错）");

  const usage = local.usageStats();
  ok(usage.monthTokens === 1700 && usage.days.length === 1 && usage.models.length === 1,
    `本地统计聚合出本月 ${usage.monthTokens} tokens / ${usage.days.length} 天 / ${usage.models.length} 个模型`);
  ok(usage.todayTokens === 1700, `今日 tokens = ${usage.todayTokens}`);

  // (d) provider `mimo` 是小米 Token Plan 通道，不能被判成按量计费
  const bt = host.billingTypeFor;
  ok(bt({}, "mimo", "mimo-v2.6-flash") === "token-plan", "provider mimo → token-plan（不看官方数据）");
  ok(bt({}, "mimo", "x", "active") === "token-plan", "官方套餐有效 → token-plan");
  ok(bt({}, "mimo", "x", "unknown") === "token-plan", "官方数据拿不到 → 仍按命名约定判套餐");
  ok(bt({}, "mimo", "x", "expired") === "payg", "官方说套餐已过期 → payg");
  ok(bt({}, "mimo", "x", "none") === "payg", "官方明确「无订阅」→ payg");
  ok(bt({}, "xiaomi-token-plan-cn", "m") === "token-plan", "provider 名含 token-plan → token-plan");
  ok(bt({}, "deepseek-official", "deepseek-chat") === "payg", "其它 provider → payg");
  ok(bt({}, "", "") === "payg", "provider 未知时保持按量这个保守默认");
  ok(bt({ billingTypeOverrides: { mimo: "payg" } }, "mimo", "x") === "payg", "provider 级显式覆盖优先");
  ok(bt({ billingTypeOverrides: { "mimo/mimo-v2.6-flash": "payg" } }, "mimo", "mimo-v2.6-flash") === "payg",
    "model 级显式覆盖优先");
  ok(bt({ billingTypeOverrides: { mimo: "token-plan" } }, "deepseek-official", "deepseek-chat") === "payg",
    "覆盖只对声明的 provider 生效");
  // (d2) 「当前选中的默认模型」必须优先于事件流 —— 用户反馈的线上问题：
  //      在 UI 里把模型切到 mimo（还没发消息），计费类型却仍显示"按量付费"。
  //      根因：modelTracker 只从 request/header 事件取模型，切了不发请求就读不到，
  //      而平台把「当前选中」记在 `agent-default-model` 命名空间里。
  {
    const mkCtx = () => ({ on: () => {} });
    // ① 默认模型是 mimo → 即使事件流里是 codebuddy（旧值），也要判 mimo
    const t1 = host.createModelTracker(mkCtx(), () => undefined, () => undefined, () => ({
      provider: "mimo",
      model: "mimo-v2.6-flash",
    }));
    ok(t1.current().provider === "mimo", `默认模型优先于事件流（实为 ${t1.current().provider}）`);
    // ② 默认模型缺失 → 回退到事件流/快照（不因读不到就返回空）
    const t2 = host.createModelTracker(mkCtx(), () => undefined, () => undefined, () => null);
    ok(typeof t2.current().provider === "string", "默认模型读不到时安全回退（不抛错）");
    // ③ 没有传 getDefaultModel（老调用方式）→ 仍可用
    const t3 = host.createModelTracker(mkCtx(), () => undefined, () => undefined);
    ok(typeof t3.current() === "object", "省略 getDefaultModel 时仍可工作（向后兼容）");
    // ④ getDefaultModel 抛错 → 不影响其它来源
    const t4 = host.createModelTracker(mkCtx(), () => undefined, () => undefined, () => {
      throw new Error("boom");
    });
    ok(typeof t4.current() === "object", "getDefaultModel 抛错时不冒泡");
    // ⑤ 默认模型只有 provider 没有 model 也要认（切模型但 model 字段暂缺）
    const t5 = host.createModelTracker(mkCtx(), () => undefined, () => undefined, () => ({ provider: "mimo" }));
    ok(t5.current().provider === "mimo", "只有 provider 时也采用默认模型");
    // ⑥ 端到端：默认模型=mimo + 套餐 active → token-plan（这正是用户场景）
    const cur = t1.current();
    ok(bt({}, cur.provider, cur.model, "active", "https://token-plan-cn.xiaomimimo.com/v1") === "token-plan",
      "切换后（默认模型=mimo）判定为 Token Plan 套餐");
  }

  // (e) 官方套餐状态的三态区分（none 是官方的否定结论，unknown 只是没结论）
  const ps = host.planStatusOf;
  ok(ps(true, { code: 0, data: { planCode: "lite:year", expired: false } }, { expired: false }) === "active",
    "detail 有套餐且未过期 → active");
  ok(ps(true, { code: 0, data: { planCode: "lite:year", expired: true } }, { expired: true }) === "expired",
    "detail expired=true → expired");
  ok(ps(true, { code: 0, data: null }, null) === "none", "code=0 但没有套餐数据 → none（明确无订阅）");
  ok(ps(true, { code: 401, message: "unauthorized" }, null) === "unknown", "code 非 0 → unknown");
  ok(ps(false, "HTTP 500", null) === "unknown", "请求失败 → unknown");
  ok(ps(false, "", null) === "unknown", "未配 Cookie → unknown");

  // (f) 按 API 地址判定计费类型（小米两条通道 baseURL 根本不同，pi-ai 目录实测）
  const url = host.billingTypeFromBaseURL;
  ok(url("https://token-plan-cn.xiaomimimo.com/v1") === "token-plan", "token-plan-cn.xiaomimimo.com → Token Plan");
  ok(url("https://token-plan-sgp.xiaomimimo.com/v1") === "token-plan", "token-plan-sgp → Token Plan");
  ok(url("https://token-plan-ams.xiaomimimo.com/v1") === "token-plan", "token-plan-ams → Token Plan");
  ok(url("https://api.xiaomimimo.com/v1") === "payg", "api.xiaomimimo.com → 按量计费");
  ok(url("") === null && url("   ") === null && url(undefined) === null, "空/非字符串地址 → null（回退其它规则）");
  ok(url("https://gateway.example.com/v1") === null, "自建网关 → null（不臆断）");

  // 优先级：显式覆盖 > API 地址 > provider 名 > 官方套餐状态
  ok(bt({}, "mimo", "x", "active", "https://api.xiaomimimo.com/v1") === "payg",
    "地址=按量 → 按量（压过「套餐状态 active」）");
  ok(bt({}, "mimo", "x", "expired", "https://token-plan-cn.xiaomimimo.com/v1") === "token-plan",
    "地址=套餐 → 套餐（压过「套餐已过期」）");
  ok(bt({ billingTypeOverrides: { mimo: "payg" } }, "mimo", "x", "active", "https://token-plan-cn.xiaomimimo.com/v1") === "payg",
    "显式覆盖压过地址");
  ok(bt({}, "xiaomi", "m", "unknown", "https://api.xiaomimimo.com/v1") === "payg", "provider xiaomi + 按量地址 → payg");
  ok(bt({}, "mimo", "x", "unknown", "") === "token-plan", "地址读不到时回退到名称/套餐状态");
  ok(bt({}, "", "", "unknown", "") === "payg", "全部信号缺失 → 按量这个保守默认");
}

// ---------- 输出 ----------
console.log("通过：");
for (const line of pass) console.log(`  ✓ ${line}`);
if (fail.length > 0) {
  console.log("\n失败：");
  for (const line of fail) console.log(`  ✗ ${line}`);
  console.log(`\n>>> ${pass.length} 通过 / ${fail.length} 失败`);
  process.exit(1);
}
console.log(`\n>>> 全部 ${pass.length} 项检查通过`);
