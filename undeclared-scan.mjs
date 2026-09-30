/**
 * 「引用了，但本文件从没声明」扫描 —— 组件/函数体里少写一行声明的事故兜底。
 *
 * 为什么需要（09-30 姊妹项目 dsh-usage-cyanmod 的真实事故）：
 *   补丁脚本中途断言退出，只写了一半的「重置卡二次确认弹层」：
 *   `confirmLayer` 引用了 `confirmReset` / `setConfirmReset` / `resetBusy` /
 *   `setResetBusy` / `resetMsg`，**但 `useState` 那三行没写进去**。
 *   症状是详情页整页打不开（`slot entry crashed in 'conversation.view'`），
 *   而**三层自检全绿**：
 *     ① `node --check` 只做语法解析，不查作用域（缺声明不是语法错）
 *     ② 正则断言只问"这段文本在不在"
 *     ③ mock 的 `createElement` 只打包参数，**永不执行组件体**
 *   只有真渲染才现形，而 headless 里会话根本打不开 → 观测不到。
 *
 * 判定规则（**全文件级**，刻意不做函数级作用域映射）：
 *   被引用的 `setXxx` 必须在本文件里**声明过**。
 *
 * 为什么不用函数级作用域映射：那要先切准每个函数体，而"解析出 0 个函数"
 *   会让检查**静默变绿**。我在 `pwtest/dsh-mimo-extension/verify-scope.mjs`
 *   上真踩过这一脚 —— 硬编码 4 空格缩进导致 `host.js`（外层缩进 0）解析出
 *   0 个函数，检查等于没跑却报"✓ 无跨作用域引用"。全文件级规则**不会误报**
 *   （任何合法引用要么本文件声明、要么是 JS 全局），代价是"声明在别的函数里"
 *   这种跨作用域误用看不见 —— 那由 `verify-scope.mjs` 与 check-client 的
 *   跨作用域检查负责，两件事分开查。
 *
 * 为什么只查 setXxx 而不查 state 值名：值名（summary / loading / position …）
 *   在 CSS 与字符串里大量出现，泛化后误报会变成打地鼠。而缺声明时 setter
 *   必然也缺（`const [a, setA] = useState()` 是整行写的），所以这一条足够兜住。
 *
 * ⚠ 阈值（`coverage`）：调用方必须断言扫描真的看到了东西。少写这个断言，
 *   规则一旦失效（改缩进、改文件结构）就会**静默变绿** —— 这正是上面那个教训。
 */

/** JS 全局 + 平台 seed 里可直接 require 的少数名字（会被当 setter 前缀误伤）。 */
const GLOBALS = new Set(
  `setTimeout clearTimeout setInterval clearInterval setImmediate
   Set WeakSet Map WeakMap
   window document globalThis self top parent frames console navigator location history
   localStorage sessionStorage indexedDB crypto performance
   Math JSON Object Array String Number Boolean BigInt Symbol Date RegExp Error TypeError
   RangeError SyntaxError ReferenceError EvalError URIError AggregateError Function Promise Proxy
   Reflect Intl parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent
   encodeURI decodeURI structuredClone queueMicrotask requestAnimationFrame cancelAnimationFrame
   requestIdleCallback cancelIdleCallback fetch Request Response Headers FormData Blob File FileReader
   URL URLSearchParams AbortController AbortSignal Event CustomEvent EventTarget MutationObserver
   ResizeObserver IntersectionObserver DOMParser XMLSerializer Node Element HTMLElement SVGElement
   DocumentFragment Audio Image Text TextEncoder TextDecoder WebSocket BroadcastChannel
   matchMedia getComputedStyle alert confirm prompt atob btoa scrollTo
   require module exports process Buffer __dirname __filename global undefined NaN Infinity`.split(/\s+/).filter(Boolean),
);

/** 把「非换行字符」换成空格 —— 保留换行与**总长度**，这样下标能直接映射回原文件行号。 */
const zap = (m) => m.replace(/[^\n]/g, " ");

/** 抹掉注释与字符串字面量（保留换行与长度）。模板整体抹掉：CSS 噪声都在那里。 */
export function stripCode(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, zap)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + zap(m.slice(lead.length)))
    .replace(/`(?:\\.|[^`\\])*`/g, zap)
    .replace(/'(?:\\.|[^'\\])*'/g, zap)
    .replace(/"(?:\\.|[^"\\])*"/g, zap);
}

/**
 * 收集本文件里出现过的**绑定名**。
 * 刻意宽松（宁可多收）：多收只会漏报，不会误报 —— 而误报会让这条检查
 * 变成噪声然后被人关掉。
 */
export function declaredNames(code) {
  const out = new Set();
  const add = (n) => {
    if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
  };
  // 数组解构：`const [summary, setSummary] = useState(...)` ← 事故现场就在这
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g))
    for (const n of m[1].split(",")) add(n.trim().split(/[=:]/)[0].trim());
  // 对象解构：`const { title, children } = props`
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g))
    for (const n of m[1].split(",")) add(n.split(":").pop().trim().split("=")[0].trim());
  // 普通声明
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 形参（含解构形参：把 {} [] 当分隔符再逐段取名字）
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g))
    for (const n of m[1].replace(/[{}[\]]/g, ",").split(",")) add(n.trim().split(/[=:]/)[0].replace(/\.\.\./, "").trim());
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // catch / for-of / import
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bimport\s+([^;]*?)\bfrom\b/g))
    for (const n of m[1].replace(/[{}*]/g, ",").split(",")) add(n.trim().split(/\s+as\s+/).pop().trim());
  return out;
}

/**
 * 扫描「被引用但全文件没声明」的名字。
 *
 * @param {string} raw        源文件全文
 * @param {RegExp} namePattern 只查匹配这个模式的名字（默认 `setXxx`）
 * @returns {{ seen: Set<string>, bad: Map<string, number>, declaredCount: number }}
 *   `seen` = 文件里出现过的匹配名（含已声明的）→ 供调用方断言"检查没空转"；
 *   `bad`  = 名字 → 首次出现的行号（1 起）
 */
export function scanUndeclared(raw, namePattern = /^set[A-Z]/) {
  const code = stripCode(raw);
  const declared = declaredNames(code);
  const seen = new Set();
  const bad = new Map();
  const lineOf = (idx) => raw.slice(0, idx).split("\n").length;
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
    const n = m[1];
    if (!namePattern.test(n)) continue;
    const after = code.slice(m.index + n.length);
    if (/^\s*:/.test(after) && !/^\s*::/.test(after)) continue; // 对象字面量的键
    seen.add(n);
    if (GLOBALS.has(n) || declared.has(n)) continue;
    if (!bad.has(n)) bad.set(n, lineOf(m.index));
  }
  return { seen, bad, declaredCount: declared.size };
}

/** 把扫描结果拼成给人看的失败详情。 */
export function describeUndeclared(bad) {
  return [...bad].map(([n, line]) => `${n}(行${line})`).join("，");
}
