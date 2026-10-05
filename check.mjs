/**
 * dsh-mimo-extension 自检脚本
 *
 * 无需 react / 浏览器：静态扫描 + 用忠实模拟 Cordis 上下文的 Proxy 调用 apply，
 * 专门抓住「访问未 inject 的服务属性」这类只在真实宿主里才暴露的 bug。
 *
 * 用法： node check.mjs
 */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { scanUndeclared, describeUndeclared } from "./undeclared-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fail = [];
const pass = [];
/** 环境缺失导致无法检查的项（如 CI 上没有 dsh 的 schemastery）—— 不算失败。 */
const skip = [];
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
  // 10-01 对方会话 0.2 适配把 insert.id 对齐组合包名（原 mimo-extension）
  ok(row?.id === "dsh-mimo-extension", "patch insert.id 为 dsh-mimo-extension");
  ok(row?.name === "dsh-mimo-extension", "patch insert.name 为 dsh-mimo-extension");
  ok(row?.config?.mimo !== undefined, "patch 携带 config.mimo");
  // 缩进塌陷会让 mimo 变成字符串或丢失，这里显式确认嵌套结构
  ok(typeof row?.config?.mimo === "object" && row.config.mimo !== null, "config.mimo 是对象（缩进未塌陷）");
  ok(row?.config?.mimo?.planTotalTokens === 500000000, "config.mimo.planTotalTokens 数值正确");
  ok(row?.config?.mimo?.pricing?.fallbackPrice?.input === 0, "config.mimo.pricing.fallbackPrice 嵌套完整");
}

// ---------- 3. host.js 加载与注册 ----------
const host = await import(join(here, "host.js"));
ok(typeof host.apply === "function", "host.js 导出 apply");
ok(host.name === "mimo-extension", "host 插件名为 mimo-extension");
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
    fiber: { entry: { options: { name: "dsh-mimo-extension" } } },
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
ok(loaded?.id === "dsh-mimo-extension", "client bundle id 为 dsh-mimo-extension");

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
    ok(pill?.id === "mimo-extension-pill", "胶囊 id 正确");
    ok(view?.id === "mimo-extension", "视图 id=mimo-extension");
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
    ok(/const ROUTE_PREFIX = "\/dsh-mimo-extension"/.test(hostSrc), "宿主路由前缀为 /dsh-mimo-extension（避开 /api）");
    ok(!/path: "\/api\/dsh-mimo-extension"/.test(hostSrc), "宿主未使用 /api/dsh-mimo-extension（会被核心拦截）");
    ok(/`\$\{ROUTE_PREFIX\}\/\$\{endpoint\}`/.test(clientSource), "客户端请求 /dsh-mimo-extension/*（与宿主前缀一致）");
    ok(!clientSource.includes("/api/dsh-mimo-extension"), "客户端未残留 /api/dsh-mimo-extension 路径");
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
        ok(gw("/dsh-mimo-extension/ping") === "/dsh-mimo-extension/ping", "无前缀环境下路径保持不变（直连 3081）");
        globalThis.__FNOS_GATEWAY_PREFIX__ = "/app/dsh-fnos/dsh";
        ok(gw("/dsh-mimo-extension/ping") === "/app/dsh-fnos/dsh/dsh-mimo-extension/ping", "有前缀环境下正确拼接（经网关 3080）");
        globalThis.__FNOS_GATEWAY_PREFIX__ = "/app/dsh-fnos/dsh/";
        ok(gw("/dsh-mimo-extension/ping") === "/app/dsh-fnos/dsh/dsh-mimo-extension/ping", "前缀带尾部斜杠时不拼出双斜杠");
        globalThis.__FNOS_GATEWAY_PREFIX__ = "";
        ok(gw("/dsh-mimo-extension/ping") === "/dsh-mimo-extension/ping", "空前缀退化为无前缀");
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
    // 拿不到 schemastery 不代表代码有问题 —— 只说明**这台机器上没装 dsh**
    // （CI、或只 clone 了本仓库的机器都是这种情况）。这是环境缺失，不是回归，
    // 所以**跳过**而不是判失败，免得公开仓库的 CI 恒红。
    // 想强制检查就在装了 dsh 的机器上跑，或设 DSH_PROFILE_URL 指到 profile。
    skip.push(
      "设置 schema 的 describe() 契约检查已跳过（本机取不到 @deepseek-ai/schemastery）" +
        " —— 装了 dsh 后重跑即可覆盖；也可用 DSH_PROFILE_URL=file:///path/to/profiles/web/ 指定。",
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
      // 0.2 的 vol() = .volatile()：字段解析出来是**引用对象** { get() }
      // （schemastery 的 createVolatile；官方读法 `cfg.x.get()`，见
      //  dsh-agent-default-model）。断言不能直接比字符串 —— 那是加 volatile
      // 之前的写法，会把"按设计返回引用"误判成 bug。这里按契约解引用。
      //
      // 🔴 10-01 修复记录（真 bug，非断言陈旧）：引用对象是 **truthy**，所以
      //    `mimo.pillPosition ?? "header"` **不回落** → result.ui 漏出 `{}` →
      //    浏览器 PILL_SEATS[{}] = undefined → 胶囊不注册/位置乱。
      //    修法：host.js 新增 derefVolatile() + pickVolatile()，两处透传
      //    （result.ui 与 /settings 响应）改为"解引用 + 白名单回落"。
      const deref = (v) =>
        v && typeof v === "object" && typeof v.get === "function" && Object.keys(v).every((k) => k === "get")
          ? v.get()
          : v;
      // 10-02：planTotalTokens 也标了 volatile（平台要求 GUI 可写字段全 volatile）
      // → 解析出来是引用对象，必须按契约解引用后比标量。
      ok(deref(value?.mimo?.planTotalTokens) === 500000000,
        `脏输入回落默认值（planTotalTokens=${deref(value?.mimo?.planTotalTokens)}）`);
      const pos = deref(value?.mimo?.pillPosition);
      ok(pos === "header", `非法 pillPosition 回落 header（实为 ${JSON.stringify(pos)}）`);
      // 合法值必须**原样透传**（volatile 包装不得吞掉用户配置）
      const good = schema({ mimo: { pillPosition: "toolbar", wrapToolbar: false, hideViewWhenNotMiMo: true } });
      ok(deref(good?.mimo?.pillPosition) === "toolbar", "合法 pillPosition 经 volatile 透传（toolbar）");
      ok(deref(good?.mimo?.wrapToolbar) === false, "合法 wrapToolbar 经 volatile 透传（false）");
      ok(deref(good?.mimo?.hideViewWhenNotMiMo) === true, "合法 hideViewWhenNotMiMo 经 volatile 透传（true）");

      // ★ 所有 GUI 可写字段必须标 volatile —— 平台硬契约（dsh-settings:501-525）：
      //   SettingsForms.write() 内部 validatePaths(next, form) 对合并结果的每个键做
      //   isVolatilePath 校验，非 volatile 直接抛
      //   `Config field "mimo.<x>" is not volatile` → 用户点保存看到"保存失败"。
      //   10-02 真实事故：planTotalTokens 未标 → 保存报错。此断言按平台判据
      //   （schema.meta.volatile）逐字段核对 POST 会写的全部字段。
      {
        const WRITABLE = [
          "cookie", "planTotalTokens", "pillPosition", "wrapToolbar",
          "hideViewWhenNotMiMo", "visionRouting", "visionRoutingTextModels", "visionRoutingAllMimo",
        ];
        const json = schema.toJSON();
        const refs = json?.refs ?? {};
        const volatileCount = Object.values(refs).filter((n) => n?.meta?.volatile === true).length;
        ok(volatileCount >= WRITABLE.length,
          `★ schema 的 volatile 字段数 ≥ 可写字段数（${volatileCount} ≥ ${WRITABLE.length}，平台要求 GUI 可写字段全 volatile）`);
        // 行为级：POST 会写的每个字段都必须能被"volatile 表单"接受 ——
        // 用平台同款判据 isVolatilePath 的等价检查（schema 解析出的引用对象即 volatile 证据）。
        const probe = schema({ mimo: Object.fromEntries(WRITABLE.map((k) => [k, undefined])) });
        const missing = WRITABLE.filter((k) => {
          const v = probe?.mimo?.[k];
          // volatile 字段解析为引用对象（有 get）；非 volatile 是裸标量
          return !(v && typeof v === "object" && typeof v.get === "function");
        });
        ok(missing.length === 0,
          `★ 可写字段全部按 volatile 契约解析（缺: ${missing.join(", ") || "无"})`);
      }

      // 3) 走**真实的** dsh-settings.describe() —— 这正是当年抛错的代码路径。
      //    直接用它导出的 SettingsProvider.prototype，跳过整个 Cordis 装配。
      let SettingsProvider;   // 0.1.x 形状：SettingsProvider.prototype.describe()
      let redactSecrets;      // 0.2.0 形状：设置编辑器投影，导出 redactSecrets
      try {
        // 0.2.0 起 profile 不再带指向 runtime 的软链树：profile 锚点会解析到
        // last-good（上一代运行时快照，exports 形状已变）或直接失败。官方解析
        // 锚点是「dsh 安装目录 或 profile 目录」（loader skip 报错原文），
        // 所以按 [运行中的 dsh 安装 → profile] 顺序找，运行版本优先。
        const reqs = [];
        try {
          const bin = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
          if (bin) reqs.push(createRequire(realpathSync(bin)));
        } catch {
          /* PATH 上没有 dsh（CI）→ 只用 profile 锚点 */
        }
        reqs.push(coreRequire);
        for (const req of reqs) {
          try {
            const mod = req("@deepseek-ai/dsh-settings");
            if (typeof mod?.redactSecrets === "function") { redactSecrets = mod.redactSecrets; break; }
            if (typeof mod?.SettingsProvider === "function") { SettingsProvider = mod.SettingsProvider; break; }
          } catch {
            /* 试下一个锚点 */
          }
        }
        ok(typeof redactSecrets === "function" || typeof SettingsProvider === "function",
          "加载到真实 @deepseek-ai/dsh-settings（运行中的 dsh 安装优先于 last-good 快照）");
      } catch (error) {
        fail.push(`无法加载 @deepseek-ai/dsh-settings：${error.message}`);
      }
      if (typeof redactSecrets === "function") {
        // 0.2.0 官方路径：role('secret') 字段过线前必须被摘除
        // （redact.d.ts：把 schema 声明的 secret 从值里剥离并留 sidecar 记录）。
        try {
          const value = schema({ mimo: { planTotalTokens: "abc", pillPosition: "nope", cookie: "SECRET-COOKIE" } });
          const red = redactSecrets(schema, value);
          ok(!JSON.stringify(red.value).includes("SECRET-COOKIE"),
            "★ 真实 redactSecrets 摘除 cookie 明文（0.2.0 契约）");
          ok(Array.isArray(red.secrets) && red.secrets.some((s) => (s.path ?? []).join(".") === "mimo.cookie"),
            "★ sidecar 记录 mimo.cookie 位置（表单可渲染 write-only 输入）");
        } catch (error) {
          fail.push(`redactSecrets 契约失败：${error.message}`);
        }
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
          const [descriptor] = makeStub("dsh-mimo-extension", schema).describe({ redactSecrets: true });
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
    // 09-27 变更：不再"跳过注册"，而是退到**兜底 schema**。
    // 原因：注册失败 = 连写权限都没有 → 改名迁移写不进去（用户的 Cookie 搬不过来）。
    // 兜底 schema 仍必须提供 toJSON()，否则会把整个设置页拖垮（踩坑 1）。
    ok(/buildFallbackSettingsSchema/.test(hostSource), "有兜底 schema 工厂");
    ok(/buildMimoSettingsSchema\(settingsCtx\) \?\? buildFallbackSettingsSchema\(\)/.test(hostSource),
      "拿不到 schemastery 时退到兜底 schema（保住写权限，迁移才能落盘）");
    ok(/resolve\.toJSON = \(\) => \(\{/.test(hostSource),
      "★ 兜底 schema 也提供 toJSON()（缺它会让整个设置页抛错）");
    ok(/改用兜底 schema 注册/.test(hostSource), "降级时会打日志说明（不是静默）");
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

  // 缓存策略回归（09-27 拆缓存）：本地部分**永远即时**、官方三连按 TTL 缓存、
  // 三个外部请求**必须并行**（原为串行 3×15s=45s）。用户问过"能否关掉 TTL"，
  // 实测全关的坏处（0.7ms→0.18s、失去故障退避、多标签页放大）→ 采用拆分方案。
  {
    const src = readFileSync(join(here, "host.js"), "utf8");

    // (A) summary 级缓存已移除 → provider/计费/计数每次都重算
    const st = src.indexOf("const getSummary = (signal)");
    ok(st > 0, "host 有 getSummary 入口");
    if (st > 0) {
      let depth = 0;
      let en = -1;
      for (let k = src.indexOf("{", st); k < src.length; k++) {
        const c = src[k];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            en = k + 1;
            break;
          }
        }
      }
      const body = src.slice(st, en);
      ok(!/CACHE_TTL_MS/.test(body), "getSummary 不做整体 TTL 缓存（本地部分每次重算）");
      ok(/inflight/.test(body), "保留并发去重（多标签页共享一次构建）");
      ok(!/cached = value/.test(body), "不把结果写回 summary 级缓存");
    }

    // (B) 官方三连有自己的 TTL 缓存
    ok(/deps\.getOfficial = async/.test(src), "官方三连单独缓存（deps.getOfficial）");
    const off = src.indexOf("deps.getOfficial = async");
    const offSeg = src.slice(off, off + 3000);
    ok(/Date\.now\(\) - officialAt < CACHE_TTL_MS/.test(offSeg), "官方数据带 TTL 判断（60s）");
    ok(/officialCache = value;/.test(offSeg) && /officialAt = Date\.now\(\);/.test(offSeg),
      "官方结果写入缓存（含失败结果 → 对上游的隐式熔断）");
    ok(/if \(officialInflight\) return officialInflight;/.test(offSeg), "官方请求并发去重");

    // (C) 三个外部请求必须并行
    ok(/Promise\.all\(\s*\[\s*fetchJson\(`\$\{apiBase\}\/balance`/.test(src),
      "三个官方请求并行（Promise.all）—— 串行时最坏 3×15s=45s");
    const fcCount = (src.slice(off, off + 3000).match(/fetchJson\(`\$\{apiBase\}/g) || []).length;
    ok(fcCount === 3, `三个 fetchJson 都在并行块内（实为 ${fcCount}）`);

    // (D) refresh=1 必须连官方数据一起重取（否则"刷新"形同虚设）
    ok(/buildSummary\(deps, undefined, \{ refreshOfficial: true \}\)/.test(src),
      "refresh=1 强制重取官方三连");
    ok(/force: options\.refreshOfficial === true/.test(src),
      "buildSummary 把 refresh 标记透传给 getOfficial");

    // (E) Cookie 变化必须作废官方缓存（否则新 Cookie 要等 60s 才生效）
    ok(/clearOfficialCache/.test(src) && /deps\.clearOfficialCache = \(\) =>/.test(src),
      "有 clearOfficialCache 供设置变化时调用");
    ok((src.match(/deps\.clearOfficialCache\?\.\(\);/g) || []).length >= 2,
      "settings watch 与 settings POST 都作废官方缓存（≥2 处）");
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

  // ---------- 改名 + 旧配置迁移（09-27 加 0.3.0）----------
  // 插件 `dsh-mimo-usage` → `dsh-mimo-extension`；用户配置（**含 Cookie**）
  // 存在旧命名空间里，必须自动搬到新段，否则用户凭空丢配置。
  {
    const src = readFileSync(join(here, "host.js"), "utf8");
    ok(host.name === "mimo-extension", `插件 id = mimo-extension（实为 ${host.name}）`);
    // 🔴 10-02 修正（plugin-settings-check 30/32 抓到的真 bug）：
    // 0.2 实测（dsh --profile web --dump-config）loader 条目的 options.id 是**全名**
    // `dsh-mimo-extension`（= cordis.patch.yml 的 `- id:`），settings.write(ns) /
    // register(ns) 按 `row.options.id === ns` 查条目 → SETTINGS_NS 必须是**全名**。
    // 10-01 曾误改成短名 `mimo-extension`（且本断言跟着写成"短名一致"，逻辑自相矛盾）
    // → 保存报 `No configurable plugin entry`、用户配置段读不到。
    // 实测：用户 Cookie 在 loader `config.mimo`（全名段），settings.yaml 无短名段。
    ok(/const SETTINGS_NS = "dsh-mimo-extension";/.test(src),
      "设置命名空间 = 全名（与 loader options.id / bundle patch - id 一致）");
    ok(/const LEGACY_SETTINGS_NS_FULL = "dsh-mimo-extension";/.test(src), "全名保留为迁移来源之一");
    // ★ 旧名必须**只**作为迁移来源保留
    ok(/const LEGACY_SETTINGS_NS = "dsh-mimo-usage";/.test(src), "保留旧命名空间常量作迁移来源");
    const legacyUses = (src.match(/LEGACY_SETTINGS_NS/g) || []).length;
    ok(legacyUses >= 2, `LEGACY_SETTINGS_NS 被真正使用（${legacyUses} 处：定义 + 读取）`);
    // 10-01 同步：旧段现在有**两个**（dsh-mimo-extension / dsh-mimo-usage），
    // host.js 用 for 循环遍历 `[LEGACY_SETTINGS_NS_FULL, LEGACY_SETTINGS_NS]` 逐个 section() 读。
    // 关键契约不变：必须用 section()（读原始 document）而不是 get()（只认已注册 ns）。
    ok(/svc\.section\(ns\)/.test(src) && /for \(const ns of \[LEGACY_SETTINGS_NS_FULL, LEGACY_SETTINGS_NS\]\)/.test(src),
      "★ 用 settings.section() 遍历两个旧段读（不是 get()）");
    // ⚠ get() 只返回已注册命名空间 → 旧段读不到，迁移会静默失效
    ok(!/settingsService\.get\(LEGACY_SETTINGS_NS\)/.test(src),
      "★ 不用 get() 读旧段（它只认已注册 ns，会静默失败）");
    // 幂等 + 不覆盖
    ok(/if \(currentMimo && typeof currentMimo === "object" && Object\.keys\(currentMimo\)\.length > 0\)/.test(src),
      "新段已有配置时不覆盖（幂等）");
    ok(/const legacyMimo = legacy\.mimo;/.test(src), "只迁移 mimo 子对象");
    // 🔴 顺序：update 要求 ns 已注册 → 迁移必须在 register 之后
    const regIdx = src.indexOf("settingsCtx.settings.register(SETTINGS_NS");
    const migIdx = src.indexOf("deps\n        .migrateLegacySettings?.()") >= 0
      ? src.indexOf(".migrateLegacySettings?.()")
      : src.indexOf("migrateLegacySettings?.()");
    ok(regIdx > 0 && migIdx > 0 && regIdx < migIdx,
      "★ 迁移调用在 register **之后**（update 要求命名空间已注册）");
    // 迁移不该删旧段（留作回滚）
    ok(!/unset.*LEGACY_SETTINGS_NS|delete.*legacy/i.test(src), "不删除旧段（留作回滚依据）");
  }

  // ---------- 夜间 0.8x 系数（09-30 用户需求）----------
  // 官方口径：北京时间 00:00–08:00 消耗系数 0.8。
  // ⚠ 必须**按事件时刻**判定，不能按天（一个自然日跨两段，按天会整日打折）。
  {
    const src = readFileSync(join(here, "host.js"), "utf8");
    ok(/const OFFPEAK_RATIO = 0\.8;/.test(src), "有非高峰系数常量");
    ok(/export function isOffPeakHour\(timeMs\)/.test(src), "有按时刻的时段判定");
    ok(/beijingHour >= 0 && beijingHour < 8/.test(src), "★ 判定区间为北京 00:00–08:00");
    // 🔴 时区必须用固定 UTC+8，不能用 getHours()（依赖系统时区）
    ok(/new Date\(t \+ 8 \* 3600_000\)\.getUTCHours\(\)/.test(src),
      "★ 用固定 UTC+8 偏移换算（不依赖运行环境时区）");
    ok(!/isOffPeakHour[\s\S]{0,200}getHours\(\)/.test(src), "未误用本地 getHours()");
    // 系数必须乘到三个分量上（漏乘会让"分量之和 ≠ 总量"）
    ok(/const ratio = isOffPeakHour\(timeMs\) \? OFFPEAK_RATIO : 1;/.test(src), "算出倍率");
    const ratioUses = (src.match(/\* ratio;/g) || []).length;
    ok(ratioUses === 3, `★ 三个分量都乘了倍率（实为 ${ratioUses} 处）`);
    // 事件时刻传入
    ok(/estimateCredits\(provider, model, usage, ev\.time\)/.test(src),
      "★ 调用时传入事件时间（不是当前时间）");
    ok(/offPeak: ratio < 1/.test(src), "返回值带 offPeak 标记");
  }

  // ---------- 启动同步顺序（09-28：预设"出现后又消失"）----------
  // 同步读的是 currentMimo()（用户层），而 userSettings 在 register 才赋值。
  // 同步调用若在 register 之前，currentMimo 回退 patch 配置（无这些开关）
  // → want 恒 false → 每次重启删除已装的预设 / 剥掉已声明的 image。
  {
    // 自包含读取：本块位于外层 `src` 声明之前（TDZ），不能引用外层变量
    const lines = readFileSync(join(here, "host.js"), "utf8").split("\n");
    const findLine = (re) => lines.findIndex((l) => re.test(l));
    const regLine = findLine(/userSettings = scope;/);
    const visLine = findLine(/deps\.syncVisionRouting\?\.\(\)/);
    ok(regLine > 0 && visLine > regLine,
      `★ 启动同步必须在 register 之后（register → vision 顺序）`);
  }

  // ---------- 视觉路由覆盖自建小米渠道（09-28 用户反馈）----------
  // 用户开了开关，往自建 `mimo` 渠道（baseURL 指向 xiaomimimo.com）贴图仍被拒 ——
  // 因为静态表只认内置渠道名。现在动态发现同源地址的自建渠道。
  {
    const src = readFileSync(join(here, "host.js"), "utf8");
    ok(/isMiMoBaseURL\(profile\?\.baseURL\)/.test(src),
      "★ 自建渠道按 **地址** 判定（isMiMoBaseURL，与 MiMo 身份判定同源）");
    ok(!/providerName === "mimo"/.test(src), "不按渠道名写死（自建渠道名字任意）");
    ok(/\/^-pro|-ultraspeed\/i|\/-pro|-ultraspeed\/i/.test(src.replace(/\n/g," ")) || /-pro|-ultraspeed/i.test("x"),
      "v2.5-pro/ultraspeed 归入纯文本表（子开关）");
    ok(/\^mimo-\/i/.test(src), "只处理 mimo 系模型（其余模型不动）");
    // 幂等：动态归类的模型并入 mmKeys/txtKeys 集合（Set 天然去重）
    ok(/txtKeys\.add\(k\); else mmKeys\.add\(k\);/.test(src.replace(/\n/g, " ")),
      "自建渠道模型并入集合（Set 去重 = 幂等）");
  }

  // ---------- 登录失效识别 + Cookie 校验端点（09-28 加）----------
  {
    const src = readFileSync(join(here, "host.js"), "utf8");
    // fetchJson 必须带状态码：判断 401 不能靠正则匹配错误串
    ok(/status: res\.status,/.test(src), "fetchJson 失败时带上 HTTP 状态码");
    ok(/function isUnauthorized\(v\)/.test(src), "有 isUnauthorized 判定");
    ok(/v\.status === 401/.test(src), "★ 以状态码 401 判定登录失效（不匹配错误文案）");
    ok(/function msgOf\(v\)/.test(src), "有 msgOf 兼容旧字符串形态");
    // authExpired 贯穿
    ok(/authExpired: false,/.test(src), "结果结构里有 authExpired");
    ok(/result\.authExpired = official\.authExpired === true/.test(src), "authExpired 传进 summary");
    ok(/value\.authExpired =/.test(src), "官方失败时按 401 置位");
    // 校验端点
    ok(/ROUTE_PREFIX \+ "\/validate-cookie"/.test(src), "新增 /validate-cookie 端点");
    ok(/if \(req\.method !== "POST"\)/.test(src), "该端点只接受 POST");
    ok(/const valid = okB \|\| okD \|\| okU;/.test(src), "有效判据：任一官方接口可用");
    // ⚠ 校验不得落盘、不得回传凭据
    const seg = src.slice(src.indexOf("validate-cookie"), src.indexOf("validate-cookie") + 2200);
    ok(!/patch\.cookie/.test(seg) && !/userSettings\.update/.test(seg),
      "★ 校验不写设置（只验不存）");
    ok(!/cookie: candidate,/.test(seg), "★ 不回传凭据本身");
  }

  // ---------- 视觉路由（09-27 加）----------
  // 用户需求：在详情页加开关，启用 MiMo 的视觉路由。
  // 平台按 `inputModalities` 硬拦截图片附件（MODEL_DOES_NOT_SUPPORT_IMAGES），
  // 该值来自 llm-pi-ai 每个模型的 `input`。开关把多模态模型的 input 写全。
  {
    const mm = host.isBuiltinMultimodal;
    const list = host.BUILTIN_MULTIMODAL_MODELS;
    ok(Array.isArray(list) && list.length === 4, `内置多模态表有 4 条（实为 ${list?.length}）`);
    for (const prov of ["xiaomi","xiaomi-token-plan-cn","xiaomi-token-plan-sgp","xiaomi-token-plan-ams"]) {
      ok(mm(prov, "mimo-v2.5") === true, `${prov}/mimo-v2.5 是多模态`);
    }
    // ★ 关键：不能误伤纯文本模型
    ok(mm("xiaomi-token-plan-cn", "mimo-v2.5-pro") === false,
      "★ mimo-v2.5-pro（catalog 标 text）不被当成多模态");
    ok(mm("xiaomi", "mimo-v2.5-pro-ultraspeed") === false, "mimo-v2.5-pro-ultraspeed 也不是");
    ok(mm("mimo", "mimo-v2.6-flash") === false, "自建 provider 不在内置表（能力由用户自己声明）");
    ok(mm("", "") === false && mm(undefined, undefined) === false, "空输入安全返回 false");

    const src = readFileSync(join(here, "host.js"), "utf8");
    ok(/deps\.applyVisionRouting = async/.test(src), "有 applyVisionRouting 写入器");
    ok(/settingsService\.mutate\("llm-pi-ai", ops\)/.test(src),
      "走 settings.mutate 写 llm-pi-ai（路径寻址，不重写整个 provider）");
    ok(/ops\.push\(\{ op: "set", path: \["providers", provider, "models"\], value: nextList \}\)/.test(src),
      "op 指向 providers.<p>.models 且值为整条数组");
    ok(/\[\.\.\.new Set\(\[\.\.\.cur, "image"\]\)\]/.test(src),
      "已开启时保留其它模态并追加 image（去重）");
    ok(/cur\.filter\(\(x\) => x !== "image"\)/.test(src), "关闭时去掉 image");
    ok(/\? cur\.filter\(\(x\) => x !== "image"\)\s*\n\s*: \["text"\]/.test(src),
      "回收后为空则补回 text（避免空数组）");
    // ⚠ 启动同步的位置：必须在 register 之后（09-28 修正，见下方断言）
    const syncIdx = src.indexOf("deps.syncVisionRouting?.()");
    // 09-28 修正：同步顺序的锚从「schema 判空之前」改为「register 之后」——
    // 兜底 schema 引入后注册必定发生，而同步必须读到**用户层**偏好
    //（userSettings 在 register 才赋值；放前面会读到 patch 层 → want 恒 false
    // → 每次重启删除已装的「MiMo 模式」预设 / 剥掉 image 声明，用户实测踩到）。
    const regIdx2 = src.indexOf("userSettings = scope;");
    ok(syncIdx > 0 && regIdx2 > 0 && syncIdx > regIdx2,
      "★ 启动同步在 register **之后**（否则读到 patch 层，开关全部失效）");
    ok(/visionRouting: bool\(mimo\.visionRouting, false\)/.test(src), "normalize 支持 visionRouting");
    // 10-02：数值/布尔字段改标 volatile（vol(...) 包裹）以满足平台写入契约，
    // 断言要容忍 vol() 包裹形态。
    ok(/visionRouting: vol\(factory\.boolean\(\)\.default\(false\)\)/.test(src),
      "schema 支持 visionRouting（默认关 + volatile 可写）");
    ok(/visionChanged: vision\.changed/.test(src) && /visionError: vision\.error/.test(src),
      "POST /settings 回传结果（失败要能看见）");
    // 为纯文本模型提供视觉能力（子开关）
    ok(Array.isArray(host.BUILTIN_TEXT_ONLY_MODELS) && host.BUILTIN_TEXT_ONLY_MODELS.length === 5,
      `文本模型表 5 条（实为 ${host.BUILTIN_TEXT_ONLY_MODELS?.length}）`);
    ok(host.isBuiltinMultimodal("xiaomi", "mimo-v2.5-pro-ultraspeed") === false,
      "ultraspeed 归文本模型表（不是多模态）");
    // ★ 两张表不能有交集 —— 否则回收会互相打架
    {
      const multi = new Set(host.BUILTIN_MULTIMODAL_MODELS.map((e) => `${e.provider}/${e.model}`));
      const overlap = host.BUILTIN_TEXT_ONLY_MODELS.filter((e) => multi.has(`${e.provider}/${e.model}`));
      ok(overlap.length === 0, `★ 多模态表与文本表无交集（实为 ${overlap.length} 个重叠）`);
    }
    ok(/deps\.applyVisionRouting = async \(enable, allowTextOnly = false, allowAllMimo = false\)/.test(src),
      "applyVisionRouting 接受 allowTextOnly 与 allowAllMimo");
    // 回收精确性：两张表各自决定去留
    // 🔴 数组路径事故回归（09-28）：平台的 applyPathOp 只认 plain object，
    // 一旦 path 里带数组下标，整个 models 数组会被当空对象重建 →
    // 连 id/name 都丢 → schema 校验失败 → **整个 provider 从 llm-pi-ai 消失**。
    ok(/path: \["providers", provider, "models"\]/.test(src),
      "★ op 的 path 停在 models（不含数组下标）");
    ok(!/path: \["providers", provider, "models", String\(idx\)/.test(src),
      "★ 已不再使用带数组下标的 path（那是数据损坏的根因）");
    // 同一 provider 必须只推一条 op（整条数组替换，多条会互相覆盖）
    // 聚合方式 09-28 演进：先按目标表分组（byProvider Map），
    // 重构为直接遍历 providers —— 管辖判定收进 wantImage/managed，
    // 每个 provider 仍只推**一条** op（整条数组替换，多条会互相覆盖）。
    ok(/for \(const \[provider, profile\] of Object\.entries\(providers\)\)/.test(src),
      "★ 直接遍历 providers 生成 op（每 provider 一条）");
    ok(/touched = true;/.test(src), "有变更才推 op（touched 标记）");
    // 值必须是完整数组且元素保留 id/name
    ok(/return \{ \.\.\.m, input: next \};/.test(src), "value 里浅拷贝模型对象（保留 id/name）");
    // 统一 want：三开关并集；**管辖外的模型永不改动**
    //（openai-codex 等渠道目录声明的 image 绝不能被当"多余"回收）
    ok(/const managed = \(providerName, modelId, profile\) =>/.test(src),
      "★ 有管辖判定 managed（只改自己管辖的模型）");
    ok(/mmKeys\.has\(k\) \|\| txtKeys\.has\(k\) \|\| channelIsMimo\(providerName, profile\)/.test(src.replace(/\n/g, " ")),
      "★ 管辖 = 多模态表 ∪ 文本表 ∪ MiMo 渠道");
    ok(/if \(!managed\(provider, m\.id, profile\)\) return m;/.test(src),
      "★ 管辖外原样保留（不回收别人声明的 image）");
    ok(/const wantImage = \(providerName, modelId, profile\) =>/.test(src),
      "统一 want 函数（三开关并集，不做统一删 image 收尾）");
    ok(/if \(allowTextOnly && txtKeys\.has\(k\)\) return true;/.test(src), "文本模型只在子开关开启时才写");
    ok(/if \(allowAllMimo && channelIsMimo\(providerName, profile\)\) return true;/.test(src),
      "★ 全量开关：MiMo 渠道上的全部模型");
    ok(/visionRoutingTextModels: bool\(mimo\.visionRoutingTextModels, false\)/.test(src),
      "normalize 支持 visionRoutingTextModels");
    ok(/visionRoutingTextModels: vol\(factory\.boolean\(\)\.default\(false\)\)/.test(src),
      "schema 支持 visionRoutingTextModels（默认关 + volatile 可写）");
    ok(/const allowTextOnly = want && mimo\.visionRoutingTextModels === true;/.test(src),
      "★ 子开关只在主开关也开时生效");
  }

  // ---------- 平台内置 provider 识别（09-27 修）----------
  // 用户反馈：用 `xiaomi-token-plan-cn/mimo-v2.5` 时没被识别成 MiMo。
  // 根因：旧规则只匹配 `/mimo/i`，而平台内置 provider 名**不含 mimo**。
  {
    const chan = host.resolveMiMoChannel;
    const url = host.isMiMoBaseURL;
    const B = host.builtinBaseURL;

    // 内置地址表必须与 pi-ai catalog 一致
    ok(B("xiaomi-token-plan-cn") === "https://token-plan-cn.xiaomimimo.com/v1",
      "内置表：xiaomi-token-plan-cn 地址正确");
    ok(B("xiaomi-token-plan-sgp") === "https://token-plan-sgp.xiaomimimo.com/v1",
      "内置表：xiaomi-token-plan-sgp 地址正确");
    ok(B("xiaomi-token-plan-ams") === "https://token-plan-ams.xiaomimimo.com/v1",
      "内置表：xiaomi-token-plan-ams 地址正确");
    ok(B("xiaomi") === "https://api.xiaomimimo.com/v1", "内置表：xiaomi（按量）地址正确");
    ok(B("不存在的") === "", "内置表：未知 provider → 空串");

    // 地址判定（铁证）
    ok(url("https://token-plan-cn.xiaomimimo.com/v1") === true, "isMiMoBaseURL：套餐网关 → true");
    ok(url("https://api.xiaomimimo.com/v1") === true, "isMiMoBaseURL：按量网关 → true");
    ok(url("https://api.openai.com/v1") === false, "isMiMoBaseURL：别家 → false（不是 null）");
    ok(url("") === null, "isMiMoBaseURL：空地址 → null（未知，不能当 false）");
    ok(url("不是URL") === null, "isMiMoBaseURL：非法 URL 且无域名 → null");

    // ★ 用户场景：内置套餐 provider，名字不含 mimo，但地址证明是小米
    {
      const r = chan({ provider: "xiaomi-token-plan-cn", model: "mimo-v2.5", baseURL: B("xiaomi-token-plan-cn") });
      ok(r.isMiMo === true && r.certain === true && r.reason === "baseURL",
        "★ xiaomi-token-plan-cn/mimo-v2.5 → 识别为 MiMo（按地址，确信）");
    }
    // 名字不含 mimo 且地址也没读到 → 靠 provider 名（xiaomi）兜底
    {
      const r = chan({ provider: "xiaomi-token-plan-sgp", model: "" });
      ok(r.isMiMo === true && r.certain === false && r.reason === "provider-name",
        "地址缺失时按 provider 名（xiaomi*）兜底，标 certain=false");
    }
    // 地址未知、只有模型名像
    {
      const r = chan({ provider: "some-proxy", model: "mimo-v2.5" });
      ok(r.isMiMo === true && r.certain === false && r.reason === "model-name",
        "地址缺失时按 model 名（mimo*）兜底");
    }
    // 地址明确不是小米 → 否决名字（防"名含 mimo 却指向别家"）
    {
      const r = chan({ provider: "mimo-gateway", model: "mimo-v2.5", baseURL: "https://api.openai.com/v1" });
      ok(r.isMiMo === false && r.certain === true,
        "★ 地址不是小米域名时否决名字（mimo-gateway→openai 判非 MiMo）");
    }
    // 完全无关
    {
      const r = chan({ provider: "codebuddy", model: "deepseek-v4.1-flash" });
      ok(r.isMiMo === false, "codebuddy/deepseek → 非 MiMo");
    }

    // 计费类型（沿用地址否决）
    ok(bt({}, "xiaomi-token-plan-cn", "mimo-v2.5", "active", B("xiaomi-token-plan-cn")) === "token-plan",
      "★ xiaomi-token-plan-cn → token-plan");
    ok(bt({}, "xiaomi-token-plan-sgp", "mimo-v2.5", "active", B("xiaomi-token-plan-sgp")) === "token-plan",
      "xiaomi-token-plan-sgp → token-plan");
    ok(bt({}, "xiaomi", "mimo-v2.5", "active", B("xiaomi")) === "payg",
      "★ 内置 xiaomi（按量地址）→ payg（同是小米，但通道不同）");
    ok(bt({}, "mimo-gateway", "mimo-v2.5", "active", "https://api.openai.com/v1") === "payg",
      "★ 名含 mimo 但地址是别家 → payg（地址否决名字）");
    ok(bt({}, "mimo", "mimo-v2.6-flash", "active", "") === "token-plan",
      "自建 mimo、地址未知 → 仍按套餐（兼容旧行为）");
  }
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

// ---------- host.js 引用「全文件都没声明」的 setXxx（09-30 加）----------
// 姊妹项目 dsh-usage-cyanmod 的事故（补丁只写了一半 → 组件每次渲染抛
// ReferenceError → 整槽崩溃）在 host 半同样成立，只是症状不同：host.js 里
// 少写一行声明，表现为 `/summary` 直接 500。
// 本项目真有先例：`loadCreditsStats` 引用了只声明在 settings inject 回调里的
// `dshHomeDir` → `/summary` 500 `loadCreditsStats is not defined`。
// 那一类是"声明在**别的函数**里"（`pwtest/dsh-mimo-extension/verify-scope.mjs`
// 负责）；本项查的是"**全文件都没声明**"，两者分工不同、都要有。
// 判定与阈值说明见 `undeclared-scan.mjs` 顶部。
{
  const raw = readFileSync(join(here, "host.js"), "utf8");
  const { seen, bad, declaredCount } = scanUndeclared(raw);
  // 覆盖断言：防"规则失效 → 什么都没扫到 → 静默变绿"
  ok(declaredCount >= 100,
    `host.js 未声明扫描生效（收集到 ${declaredCount} 个声明名、${seen.size} 种 setXxx）`);
  ok(bad.size === 0,
    `★ 无引用未声明的 setXxx（缺声明会让 /summary 500）${bad.size ? `：${describeUndeclared(bad)}` : ""}`);
}

// ---------- 0.2 写通道：writable 必须跟 POST 的回退通道一致 ----------
// 0.2 下 settings.register 可能静默失败（scope null → writable false），
// 但 POST 有 SettingsForms.update 回退 —— 两边不一致时表单保存按钮被永久禁用
// （0.2 实测：GET 回 writable:false、Save disabled）。反向验证过（去掉回退即报红）。
{
  const hostSource = readFileSync(join(here, "host.js"), "utf8");
  // 10-01 对方会话把 settingsCtx.settings 改名为 settingsService（语义相同）
  ok(/writable:\s*Boolean\(userSettings\)\s*\|\|\s*typeof settingsService\?\.update/.test(hostSource),
    "★ writable 跟随 0.2 写回退通道（否则表单保存按钮永久禁用）");
}

  // ---------- 10-01 修复：volatile 引用对象不得从 result.ui / settings 漏出 ----------
  // 根因：.volatile() 字段解析出来是引用对象 { get() }，对象是 truthy，
  //       `mimo.pillPosition ?? "header"` **不回落** → JSON 序列化后变 `{}` →
  //       浏览器 PILL_SEATS[{}] = undefined → 胶囊不注册/位置乱。
  // 修法：derefVolatile() 解引用 + pickVolatile() 白名单回落，两处透传都要用。
  // 反向验证：把任一处的 pickVolatile 换回 `?? "header"` → 本条报红。
  {
    // 本地读一次源码（本块独立作用域，外层的 hostSrc 在别的块里）
    const hostSrc = readFileSync(join(here, "host.js"), "utf8");
    ok(/function derefVolatile\(v\)/.test(hostSrc), "★ 有 volatile 引用解包器 derefVolatile()");
    ok(/function pickVolatile\(v, allowed, fallback\)/.test(hostSrc),
      "★ 有 volatile 白名单回落器 pickVolatile()");
    ok(/const PILL_POSITIONS = \["header", "toolbar", "above", "hidden"\];/.test(hostSrc),
      "胶囊位置白名单常量与 mimoSettingsSchema 一致");
    // 两处透传必须都走 pickVolatile（不能留裸 ?? ）
    const pickUses = (hostSrc.match(/pickVolatile\(/g) || []).length;
    ok(pickUses >= 2, `result.ui 与 /settings 两处透传都用 pickVolatile（${pickUses} 处）`);
    ok(!/pillPosition:\s*mimo\.pillPosition\s*\?\?/.test(hostSrc),
      "★ 不再有裸 \`mimo.pillPosition ?? ...\`（对象 truthy 不回落）");
    ok(!/pillPosition:\s*m\.pillPosition\s*\?\?/.test(hostSrc),
      "★ 不再有裸 \`m.pillPosition ?? ...\`（/settings 响应同样要解引用）");
    // 行为级：deref 必须真能取出值（不只是有函数）
    const fakeRef = { get: () => "toolbar" };
    ok(
      typeof host.derefVolatile === "function" && host.derefVolatile(fakeRef) === "toolbar",
      "derefVolatile 对引用对象返回其 get() 的值",
    );
    if (typeof host.derefVolatile === "function" && typeof host.pickVolatile === "function") {
      ok(host.pickVolatile(fakeRef, ["header", "toolbar"], "header") === "toolbar",
        "pickVolatile 接受引用对象并透传合法值");
      ok(host.pickVolatile({ get: () => "evil" }, ["header", "toolbar"], "header") === "header",
        "pickVolatile 对非法值回落兜底");
      ok(host.pickVolatile({ get: () => 123 }, ["header"], "header") === "header",
        "pickVolatile 对非字符串回落兜底");
    }
  }
// ---------- 0.2 读**别人的**命名空间：必须走 configEditor ----------
// `settings.get(ns)` 在 0.2 的 SettingsForms 上**不存在**（该类只有
// describe/schema/update/mutate/write/replace）→ 调用必抛 → 被 catch 吞掉 →
// 表现为「读不到 llm-pi-ai 命名空间」（视觉路由设置失败的真正原因，10-02）。
// 官方 describe() 内部用的也是同一条路径：configEditor.configuration()。
{
  const hostSource = readFileSync(join(here, "host.js"), "utf8");
  ok(/function readNamespaceDoc\(ns\)/.test(hostSource),
    "★ 有 readNamespaceDoc 统一读取器（走 configEditor）");
  ok(/configEditor\.configuration\(\)/.test(hostSource),
    "★ 读别的命名空间走 configEditor.configuration()（官方同款路径）");
  ok(hostSource.indexOf("settingsService.get(") === -1,
    "★ 不再用 settings.get() 读别人的命名空间（0.2 无此方法）");
  ok(/export const inject = \[[^\]]*"configEditor"/.test(hostSource),
    "inject 声明含 configEditor");
  ok(/readNamespaceDoc\("llm-pi-ai"\)/.test(hostSource),
    "视觉路由经 readNamespaceDoc 读 llm-pi-ai");
}

// ---------- 写读同源：currentMimo 必须读 loader config（0.2 register 已移除） ----------
// 症状（用户实测 10-03）：设置页提示「已保存」，重进设置页**恢复原样**。
// 根因：写走 settingsService.update(SETTINGS_NS, …) 落 loader profile config，
// 而读走 `userSettings?.get?.()` —— 0.2 已移除 settings.register（register 调用
// 返回 null → userSettings 恒 null）→ 读回的永远是 {} → 用户看到默认值。
// 修法：与读 llm-pi-ai 一致，走 configEditor.configuration() 的 inherited。
{
  const hostSource = readFileSync(join(here, "host.js"), "utf8");
  ok(/const viaEditor = readNamespaceDoc\(SETTINGS_NS\)/.test(hostSource),
    "★ currentMimo 经 readNamespaceDoc(SETTINGS_NS) 读用户层（写读同源）");
  // 🔴 读的必须是**生效值** entry.options.config，不是 inherited：
  //   configuration() 的 inherited = patch 去掉 config 后的**下层值**（≈ 插件默认值），
  //   而写入路径 edit() 用 entry.options.config。读 inherited 会表现为
  //   「刚保存就又恢复原样」（10-03 实测：写盘 4.4e9 成功、GET 读回 500M）。
  {
    const fnStart = hostSource.indexOf("function readNamespaceDoc(ns)");
    const fnSeg = hostSource
      .slice(fnStart, fnStart + 1600)
      .split("\n")
      .map((line) => {
        const at = line.indexOf("//");
        return at === -1 ? line : line.slice(0, at);
      })
      .join("\n");
    ok(/row\.entry\?\.options\?\.config/.test(fnSeg),
      "★ readNamespaceDoc 读 entry.options.config（生效值，与写入路径 edit() 同源）");
    ok(!/return row\?\.inherited/.test(fnSeg),
      "★ 不把 inherited 当生效值返回（它是去掉 patch config 的下层值）");
  }
  // 禁止把裸的 userSettings 读取当**主路径**（只允许作 0.1.x 兜底，且必须在 else 分支）
  {
    const idx = hostSource.indexOf("const currentMimo = () =>");
    const rawSeg = hostSource.slice(idx, idx + 2000);
    // ⚠ 必须先剥注释：本函数的注释里**写了旧代码的写法**（说明根因），
    //   直接 indexOf 会命中注释，把干净代码测红（我第一版就这样踩了）。
    const seg = rawSeg
      .split("\n")
      .map((line) => {
        const at = line.indexOf("//");
        return at === -1 ? line : line.slice(0, at);
      })
      .join("\n");
    const bareRead = seg.indexOf("userSettings?.get?.(");
    const editorRead = seg.indexOf("readNamespaceDoc(SETTINGS_NS)");
    ok(editorRead !== -1 && (bareRead === -1 || editorRead < bareRead),
      "★ loader 读取优先于 userSettings 兜底（不得再以 userSettings 为主路径）");
  }
  ok(/mergeConfig\(merged, \{ mimo: userMimo \}\)/.test(hostSource),
    "用户层仍覆盖 patch 层（合并语义未变）");
}

// ---------- Cookie 凭据库：安全性断言（不泄露 / 用户确认 / 只写官方） ----------
// 需求：可选「登录后自动获取并更新 Cookie」，且**尽可能避免泄露与安全风险**。
// 结论（已写入 README/AGENTS）：小米只提供网页 SSO，插件**无法**在不接触用户
// 账号密码的前提下换取凭据；因此实现的是「引导 + 校验 + 安全落库 + 风险确认」，
// 以下断言保证这条链路不引入新的泄露面。
{
  const hostSource = readFileSync(join(here, "host.js"), "utf8");
  const clientSource = readFileSync(join(here, "client.js"), "utf8");

  // ① 有 save-cookie 路由，且只写凭据库
  ok(/ROUTE_PREFIX \+ "\/save-cookie"/.test(hostSource), "★ 有 /save-cookie 路由（写凭据库）");
  ok(/credentials\.set\(ref, candidate\)/.test(hostSource), "★ 走 credentials.set 写凭据库");
  ok(/credentials\.unset\(ref\)/.test(hostSource), "支持撤销（credentials.unset）");

  // ② 写库前必须校验（无效不写）
  {
    const saveIdx = hostSource.indexOf('ROUTE_PREFIX + "/save-cookie"');
    const seg = hostSource.slice(saveIdx, saveIdx + 3000);
    ok(/const valid = okB \|\| okD \|\| okU;/.test(seg), "写库前先校验（官方三连任一通）");
    ok(/if \(!valid\) \{/.test(seg) && seg.indexOf("if (!valid)") < seg.indexOf("credentials.set("),
      "★ 校验失败直接返回，不写库");
  }

  // ③ **绝不回显凭据**：save-cookie 的响应体只含 ref/saved/valid，不含 cookie 原值
  {
    const saveIdx = hostSource.indexOf('ROUTE_PREFIX + "/save-cookie"');
    const seg = hostSource.slice(saveIdx, saveIdx + 3000);
    const responses = seg.match(/writeJson\(res, \d+, \{[^}]*\}/g) ?? [];
    ok(responses.length > 0, "save-cookie 有明确响应体");
    ok(!/cookie:\s*(candidate|body)/.test(seg), "★ 响应/日志不回显 Cookie 原值");
    ok(!/console\.(log|info|warn|error)\([^)]*candidate/.test(seg), "★ 不把候选 Cookie 打进日志");
  }

  // ④ 客户端：用户确认制 + 不把凭据写进 settings 明文
  ok(/setVaultConfirm\(true\)/.test(clientSource), "★ 点按钮先弹风险确认（用户确认制）");
  ok(/data-role": "cookie-risk-confirm"/.test(clientSource), "有风险确认块（可被测试锚定）");
  ok(/cfg\.cookieRiskBody/.test(clientSource), "风险说明文案已渲染（不是只写不显示）");
  {
    // save-cookie 走独立 rpc，不混进 settings 的 payload（后者会落 settings.yaml 明文）
    const vaultCall = /rpc\("save-cookie", \{ cookie: candidate \}, "POST"\)/.test(clientSource);
    ok(vaultCall, "★ 凭据经 /save-cookie 独立通道（不落 settings 明文）");
  }
  // ⑤ 风险说明必须包含关键告知项（等同/泄密后果/存储位置/撤销方式）
  const riskBody = (hostSource.match(/cfg\.cookieRiskBody/) ? null : null) ?? null;
  const zhRisk = /"cfg\.cookieRiskBody": "([^"]+)"/.exec(clientSource)?.[1] ?? "";
  ok(/账号访问权/.test(zhRisk), "风险说明点明「等同账号访问权」");
  ok(/本机/.test(zhRisk) && /platform\.xiaomimimo\.com/.test(zhRisk), "风险说明点明存储位置与发送目标");
  ok(/清除/.test(zhRisk), "风险说明给出撤销方式");
  ok(/vaultAvailable/.test(hostSource) && /vaultAvailable/.test(clientSource),
    "凭据库不可用时界面有明确降级（不假装保存成功）");
}

// ---------- 用量口径：对齐官方 dsh-token-meter（10-05）----------
// 只读分析报告发现与 dsh-usage-cyanmod 的用量差 3~4 倍。核实后确认我们的取数
// 口径有三个叠加缺口，本轮修前两个：
//   ① 只认 assistant/message → 漏 assistant/attempt（失败/重试/取消的用量
//      只写在 data.stream 的 usage 样本里，官方 README 明确 attempt 计费）
//   ② snapshotEvents() → fork 子会话重复计父历史（应用 ownEvents()）
// 第三个（无 session/event 订阅 + 无 storageDomain 落盘 → 重启归零、
// 历史会话丢失）是 4x 缺口的主因，另轮处理。
{
  const hostSource = readFileSync(join(here, "host.js"), "utf8");
  ok(/const usageOfEvent = \(event\) =>/.test(hostSource),
    "★ 有 usageOfEvent（照抄官方 dsh-token-meter 的 usageOf 口径）");
  ok(/type === "assistant\/message" && data\.usage !== undefined/.test(hostSource),
    "口径 ①：assistant/message + data.usage 优先");
  ok(/type !== "assistant\/message" && type !== "assistant\/attempt"/.test(hostSource),
    "口径 ②：只对 message/attempt 取用量");
  ok(/record\?\.type === "chunk" && record\.chunk\?\.type === "usage"/.test(hostSource),
    "口径 ③：attempt 的用量取自 data.stream 里最后一个 usage chunk");
  // ★ 旧 bug 防回归：绝不能写死"非 assistant/message 直接 return"
  ok(!/if \(ev\.type !== "assistant\/message"\) return;/.test(hostSource),
    "★ 不再写死只认 assistant/message（会系统性漏计 attempt）");
  ok(/const usage = usageOfEvent\(ev\);/.test(hostSource),
    "handleEvent 走 usageOfEvent（不是裸读 data.usage）");

  // ★ fork：ownEvents 优先于 snapshotEvents
  ok(/typeof s\.ownEvents === "function"/.test(hostSource),
    "ingest 检查 ownEvents 可用（fork 子会话只计自有事件）");
  {
    const i1 = hostSource.indexOf("const own = ownOf(session);");
    const i2 = hostSource.indexOf("events = session.snapshotEvents();");
    ok(i1 > 0 && i2 > i1, "★ ownEvents 判定在 snapshotEvents 之前（否则重复计父历史）");
  }

  // 如实记录尚未做的部分（避免误以为已修）
  ok(!/ctx\.on\("session\/event"/.test(hostSource) === true,
    "（已知未做）尚无 session/event 订阅 —— 重启归零/历史会话丢失，另轮处理");
}

// ---------- 输出 ----------
console.log("通过：");
for (const line of pass) console.log(`  ✓ ${line}`);
if (skip.length > 0) {
  console.log("\n跳过（环境缺失，非回归）：");
  for (const line of skip) console.log(`  ⋯ ${line}`);
}
if (fail.length > 0) {
  console.log("\n失败：");
  for (const line of fail) console.log(`  ✗ ${line}`);
  console.log(`\n>>> ${pass.length} 通过 / ${fail.length} 失败${skip.length ? ` / ${skip.length} 跳过` : ""}`);
  process.exit(1);
}
console.log(`\n>>> 全部 ${pass.length} 项检查通过${skip.length ? `（${skip.length} 项因环境缺失跳过）` : ""}`);

