// ⚠⚠ 整个模块必须包在 IIFE 里，绝不能直接暴露顶层声明！⚠⚠
//
// 平台的启动批次是【一个拼接的大脚本】：所有插件的 client.js 依次拼接后作为
// 一个 <script> 执行，于是**所有模块共享同一个顶层作用域**。多个插件都声明
// 顶层 `function makeFactory(require)` 时，函数声明会提升并**后者覆盖前者** ——
// 最终每个 `__ModuleLoader__.load({ factory: makeFactory })` 拿到的都可能是
// **最后一个模块的工厂**。
//
// 实测症状（09-27，本插件第 7 个线上 bug）：本插件与 dsh-plugin-proxy 都注册
// 到了 cyanmod 的工厂 —— 它们的 factory 从不执行，`probe("factory")` 永不回传，
// 表现为"胶囊 + 详情页消失"，而 cyanmod 因为恰好排在最后而一切正常。
//
// 顶层标识符包括：makeFactory / gatewayPath / probe / sendPing / pingFetch /
// pingDelay / pingBody / bootDigest / moduleDigest / stageHistory / pingSeq /
// lastPayload / ROUTE_PREFIX。**加新代码时不要把它们挪到 IIFE 外面。**
(function () {
    // dsh-mimo-usage 浏览器半：会话头部「mimo额度」胶囊 + 「MiMo 用量」详情页。
    // 工厂格式直接注册进平台模块表，仅依赖平台共享的 react（无构建步骤）。
    //
    // 挂载点：
    //   conversation.session.header.actions —— order 30，排在 trajectory(10)/jobs(20)/额度(20) 之后，
    //     即紧跟"对话 / 轨迹"标签行右侧的动作区末尾。
    //   conversation.view —— id "mimo-usage"，label "MiMo 用量"，order 15，
    //     位于 trajectory(10) 之后、额度 dashboard balance(20) 之前。
    //
    // 显示规则：
    //   Token Plan 套餐 → 标题 mimo额度 + 剩余百分比（如 "剩余 62.4%"）
    //   按量计费（payg）→ 标题 mimo额度 + 当前会话用量（如 "会话 1.2M"）
    //
    // 自诊断：浏览器里"装了没生效"服务端是看不到的，所以每个关键节点都向宿主
    // POST 一次 /dsh-mimo-usage/ping，从 /summary 的 `client.stage` 就能读出卡在哪：
    //   module-loaded（脚本已执行）→ factory（模块表已调工厂）→
    //   apply-entered（apply 开跑）→ applied（槽位注册完成）/ skipped（被守卫拦下）
    const ROUTE_PREFIX = "/dsh-mimo-usage";
  /**
     * fnOS 网关会把页面挂在 `/app/dsh-fnos/dsh/` 下，并注入
     * `globalThis.__FNOS_GATEWAY_PREFIX__`；官方客户端模块全部靠它拼请求路径
     * （见平台 patch-dsh.mjs）。**绝对路径 `/x` 不受 `<base href>` 影响**，
     * 所以插件必须自己补这个前缀，否则经网关访问时请求会打到错误的路径上
     * （POST 落进 frontend-static 的 fallback 会得到 405 空响应，GET 得 404）。
     *
     * 直连 `http://127.0.0.1:3081` 时该变量为 undefined，退化成空串，行为不变。
     * @param {string} path 以 `/` 开头的插件路由
     * @returns {string} 可直接 fetch 的路径
     */
  function gatewayPath(path) {
    let prefix = "";
    try {
      if (typeof globalThis !== "undefined" && typeof globalThis.__FNOS_GATEWAY_PREFIX__ === "string") {
        prefix = globalThis.__FNOS_GATEWAY_PREFIX__;
      }
    } catch {
      /* 忽略 */
    }
    // 去尾部斜杠，避免拼出 `//dsh-mimo-usage`
    prefix = prefix.replace(/\/+$/, "");
    return prefix + path;
  }
  // ⚠ 动态插件的浏览器半里裸 `fetch` / `setTimeout` 是会抛错的教学陷阱
  // （cordis-client-runner 的 closureTraps），所以一律走 `window.*`；
  // 再加失败重试：探针丢一条，整条诊断链就断了。
  function pingFetch(url, init) {
    const target =
      typeof window !== "undefined" && typeof window.fetch === "function"
        ? window.fetch.bind(window)
        : typeof fetch === "function"
          ? fetch
          : null;
    if (target === null) return Promise.resolve();
    try {
      return target(url, init);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  function pingDelay(fn, ms) {
    try {
      if (typeof window !== "undefined" && typeof window.setTimeout === "function") return window.setTimeout(fn, ms);
      if (typeof setTimeout === "function") return setTimeout(fn, ms);
    } catch {
      /* 忽略 */
    }
    return 0;
  }
  let pingSeq = 0;
  function sendPing(body, attempt) {
    // 每次发送时求值：网关前缀由 HTML <head> 里的内联脚本注入，
    // 而本脚本可能先于它执行（同为启动清单成员，顺序不保证）。
    pingFetch(gatewayPath(`${ROUTE_PREFIX}/ping`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body,
    })
      .then((r) => {
        if (!r.ok && attempt < 6) pingDelay(() => sendPing(body, attempt + 1), 1500);
      })
      .catch(() => {
        if (attempt < 6) pingDelay(() => sendPing(body, attempt + 1), 1500);
      });
  }
  // 阶段历史：host 只留最近 20 条回传（心跳会把它挤掉），所以每条回传都带上
  // **完整历史**，塞进 `error` 这个自由字段（host 原样记录、截 500 字符）。
  // 这样看最后一条就知道整条链：module-loaded > factory > apply-entered > applied。
  const stageHistory = [];
  // 每次**发送时**重新取样：清单可能在 boot 过程中被换掉，脚本加载瞬间读一次不算数；
  // boot 覆盖层（[data-dsh-boot]）里若出现 "Failed to load plugins" + 本插件名，
  // 就是宿主自己报的失败原因，一并带回。
  //
  // 关键补充：boot 完成后 `__ModuleLoader__` 门面从 `queue` 切成 `live`，
  // 暴露 `factories` / `loadCache` / `graphRows` 三张表。**这三张表足以自证
  // "我们的 factory 到底有没有进表、有没有被物化"** —— 不需要借道任何别的插件，
  // 也不需要插件上下文（我们连 apply 都没进，拿不到 ctx）。
  //   factories 有我们 → 脚本执行并注册成功；没有 → 根本没到 load() 这一步
  //   loadCache 有我们 → 工厂已被物化（materialize 跑过）
  //   graphRows 有我们 → 启动清单认这条 entry
  function moduleDigest() {
    const id = "dsh-mimo-usage";
    try {
      const ml = window.__ModuleLoader__;
      if (!ml) return "ml=none";
      const keys = (m) => {
        try {
          return m && typeof m.keys === "function" ? [...m.keys()] : null;
        } catch {
          return null;
        }
      };
      const fac = keys(ml.factories);
      const cache = keys(ml.loadCache);
      if (fac === null && cache === null) return `mode=${ml.mode} tables=hidden`;
      return `mode=${ml.mode} nfac=${fac ? fac.length : "?"} ncac=${cache ? cache.length : "?"} fac=${
        fac && fac.includes(id) ? 1 : 0
      } cac=${cache && cache.includes(id) ? 1 : 0}`;
    } catch (err) {
      return `module-digest-err:${err && err.message}`;
    }
  }
  function bootDigest() {
    try {
      const boot = window.__DSH_BOOT__;
      const es = (boot && Array.isArray(boot.entries) && boot.entries) || [];
      const mine = es.find((e) => e && e.id === "dsh-mimo-usage");
      const inBatch = ((boot && Array.isArray(boot.batches) && boot.batches) || []).some(
        (b) => Array.isArray(b.entries) && b.entries.includes("dsh-mimo-usage"),
      );
      let dom = "gone";
      try {
        const el = document.querySelector("[data-dsh-boot]");
        if (el) dom = ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() || "(empty)").slice(0, 150);
      } catch {
        /* 忽略 */
      }
      return `n=${es.length} us=${mine ? 1 : 0} b=${inBatch ? 1 : 0} i=${mine && mine.immediately ? 1 : 0} j=${
        mine && Array.isArray(mine.inject) ? mine.inject.length : 0
      } r=${String((boot && boot.rev) || "").slice(0, 8)} | dom=${dom}`;
    } catch (err) {
      return `digest-err:${err && err.message}`;
    }
  }
  let lastPayload = null;
  function pingBody() {
    const p = Object.assign({}, lastPayload || {});
    p.at = Date.now();
    p.error = stageHistory.join(">");
    p.hash = `${bootDigest()} | ${moduleDigest()}`;
    return JSON.stringify(p);
  }
  function probe(stage, extra) {
    // 离线自检（Node）与非浏览器环境直接跳过，诊断绝不能反过来影响主流程
    if (typeof document === "undefined") return;
    try {
      if (stageHistory[stageHistory.length - 1] !== stage) stageHistory.push(stage);
      const payload = Object.assign({ stage }, extra ?? {});
      // 带上页面路径：同一 origin 下可能有多个标签页（工具页 / 对话页），
      // 不带 path 就分不清"哪一页没走完 boot"
      try {
        payload.path = location.pathname;
        payload.hash = location.hash || "";
      } catch {
        /* 忽略 */
      }
      payload.seq = ++pingSeq;
      lastPayload = payload;
      sendPing(pingBody(), 0);
      // 心跳：阶段停在 module-loaded 就按 3s/12s/40s 再报（每次重取清单与 DOM 样本）。
      // 心跳能到而阶段不前进 → 工厂真没跑；心跳也到不了 → 通道本身断了。
      if (stage === "module-loaded") {
        for (const beatAt of [3000, 12000, 40000]) {
          pingDelay(() => {
            if (stageHistory.length === 1) sendPing(pingBody(), 0);
          }, beatAt);
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  function makeFactory(require) {
    probe("factory");
    const react = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = react;
    // react-dom 在平台 seed 表里（`staticModules` 含 "react-dom"），
    // 用它的 createPortal 把弹层挂到 document.body —— 这是"弹窗被祖先裁掉 /
    // 跑到屏幕外"的根治办法（平台自己的 Tooltip 原语也是这么做的）。
    // 拿不到就退化为原地渲染（位置仍靠 placePopover 钳制，只是可能被裁）。
    let createPortal = null;
    try {
      const rd = require("react-dom");
      if (rd && typeof rd.createPortal === "function") createPortal = rd.createPortal;
    } catch {
      /* 老版本平台没有 react-dom 时退化为非 portal 渲染 */
    }

    const NS = "dsh.mimoUsage";
    const zh = {
      "pill.label": "mimo额度",
      "pill.loading": "…",
      "pill.error": "—",
      "pill.remain": "剩余 {percent}%",
      "pill.session": "会话 {tokens}",
      "pill.tip.plan": "MiMo Token Plan 额度（{source}）\n本月已用 {used}%\n点击查看用量",
      "pill.tip.payg": "MiMo 按量计费（当前会话）\n会话 tokens {tokens}{calls}\n点击查看用量",
      "pill.tip.loading": "MiMo 额度（加载中）",
      "pill.tip.error": "MiMo 额度查询失败（点击重试）",
      "pill.popover.title": "MiMo 额度",
      "pill.popover.billing": "计费类型",
      "pill.popover.remain": "剩余额度",
      "pill.popover.used": "本月已用",
      "pill.popover.total": "套餐总量",
      "pill.popover.session": "会话 tokens",
      "pill.popover.calls": "请求次数",
      "pill.popover.model": "当前模型",
      "pill.popover.modelLast": "最近使用的模型",
      "pill.popover.detail": "查看详情 →",
      "pill.popover.plan": "Token Plan 套餐",
      "pill.popover.payg": "按量付费",
      "pill.popover.foreign": "非 MiMo（{providers}）",
      "pill.tip.mixed": "另含非 MiMo 渠道 {tokens} tokens（{providers}），未计入上行数字",
      "view.label": "MiMo 用量",
      "view.title": "MiMo 用量与额度",
      "view.refresh": "刷新",
      "view.loading": "加载中…",
      "view.official": "数据来源：小米 MiMo 官方接口",
      "view.local": "数据来源：本地估算（官方接口不可用）",
      "view.billing.plan": "计费类型 · Token Plan 套餐",
      "view.billing.payg": "计费类型 · 按量计费",
      "view.billing.unknown": "计费类型（本会话尚无请求）",
      "view.model": "当前模型",
      "view.plan": "套餐额度",
      "view.planCode": "套餐",
      "view.periodEnd": "周期至",
      "view.expired": "已过期",
      "view.balanceNote": "Token Plan 套餐与按量付费余额互不通用，套餐用户的按量余额恒为 0，属正常。",
      "view.usedPercent": "本月已用",
      "view.remainPercent": "剩余",
      "view.used": "已用",
      "view.limit": "总量",
      "view.balance": "账户余额",
      "view.cash": "现金",
      "view.gift": "赠金",
      "view.session": "当前会话用量",
      "view.tokens": "Tokens",
      "view.calls": "调用",
      "view.input": "输入",
      "view.output": "输出",
      "view.cacheRead": "缓存命中",
      "view.breakdown": "按模型拆分",
      "view.today": "今日 tokens",
      "view.month": "本月 tokens",
      "view.stats": "用量统计（本地）",
      "view.forecast": "用量预测",
      "view.avgDaily": "近 {days} 日日均",
      "view.projected": "按此速度月底",
      "view.projectedRemain": "预计月底剩余",
      "view.todayRate": "今日速率（样本不足）",
      "view.thinSample": "已完成天数不足 3 天，预测仅供参考（今日未计入均值）。",
      "view.charge": "收费估算",
      "view.chargeNote": "Token Plan 套餐内调用不额外收费，只消耗套餐配额。",
      "view.chargeEst": "会话费用（估算）",
      "view.chargeMixNote": "本会话混用了非 MiMo 渠道，而分渠道明细只有总量、没有输入/输出拆分，故按 token 占比折算，仅供参考。",
      "view.mixed": "本会话还用过非 MiMo 渠道（不计入上方汇总）：",
      "view.mixedTotal": "合计 {tokens} tokens",
      "view.callsUnit": "次",
      "view.noBreakdown": "该会话没有分渠道明细（老计数器或统计降级），上方数字按整体统计，可能包含非 MiMo 渠道。",
      "view.notMimo": "不计入 MiMo",
      "view.modelSelected": "（当前选中）",
      "view.noMimoTitle": "本会话尚未使用 MiMo",
      "view.noMimoBody": "上面的会话用量为 0 是正常的 —— 本会话只用了 {providers}。下方「套餐额度」是账号级的，与本会话无关。",
      "view.notMimoModel": "当前模型属于 {provider}，不是 MiMo —— 下面的套餐额度是 MiMo 账号级的，不随当前模型变化。",
      "view.noData": "暂无数据",
      "view.priceMissing": "未配置单价，按 0 估算",
      "view.src.official": "官方",
      "view.src.local": "本地",
      "view.updated": "更新于",
      // —— 设置表单 ——
      "cfg.title": "MiMo 额度配置",
      "cfg.hint": "Cookie 用于读取小米官方套餐剩余；留空则用本地估算。Cookie 只保存在本机 settings.yaml，不会回传到浏览器。",
      "cfg.cookie": "MiMo 控制台 Cookie",
      "cfg.cookiePlaceholder": "api-platform_serviceToken=...; userId=...",
      "cfg.cookieConfigured": "已配置（{source}）",
      "cfg.cookieEmpty": "未配置",
      "cfg.cookieKeep": "留空则保持不变",
      "cfg.clearCookie": "清除已保存的 Cookie",
      "cfg.planTotal": "本地兜底套餐总量（tokens/月）",
      "cfg.pillPosition": "额度胶囊位置",
      "cfg.pos.header": "标题行（对话 / 轨迹 右侧）",
      "cfg.pos.toolbar": "输入框工具栏",
      "cfg.pos.above": "输入框上方",
      "cfg.pos.hidden": "不显示胶囊",
      "cfg.wrapToolbar": "允许输入框工具栏自动换行（防止工具图标挤占重叠）",
      "cfg.save": "保存",
      "cfg.saving": "保存中…",
      "cfg.saved": "已保存",
      "cfg.saveFailed": "保存失败：{error}",
      "cfg.readonly": "当前环境设置不可写（settings 服务未装配）",
      "cfg.cookieHelp": "获取步骤：登录 platform.xiaomimimo.com → DevTools → Network → 任一 /api/v1 请求 → 复制完整 Cookie 请求头（需含 api-platform_serviceToken 与 userId）。",
      "cfg.paste": "粘贴",
      "cfg.pasteDone": "已从剪贴板填入（记得点保存）",
      "cfg.pasteFail": "读不到剪贴板，请手动按 Ctrl+V，或右键粘贴",
      "cfg.cookieWhy": "这个 Cookie 用来读**套餐（Token Plan）**额度：tokenPlan/detail 与 tokenPlan/usage 两个接口都必须带它；按量计费的余额（balance）也是同一个接口域。不填则只能用本地估算。",
    };
    const en = {
      "pill.label": "MiMo quota",
      "pill.loading": "…",
      "pill.error": "—",
      "pill.remain": "{percent}% left",
      "pill.session": "{tokens} in session",
      "pill.tip.plan": "MiMo Token Plan quota ({source})\n{used}% used this month\nClick for usage",
      "pill.tip.payg": "MiMo pay-as-you-go (this session)\n{tokens} tokens{calls}\nClick for usage",
      "pill.tip.loading": "MiMo quota (loading)",
      "pill.tip.error": "MiMo quota lookup failed (click to retry)",
      "pill.popover.title": "MiMo quota",
      "pill.popover.billing": "Billing",
      "pill.popover.remain": "Remaining",
      "pill.popover.used": "Used this month",
      "pill.popover.total": "Plan total",
      "pill.popover.session": "Session tokens",
      "pill.popover.calls": "Requests",
      "pill.popover.model": "Model",
      "pill.popover.modelLast": "Last used model",
      "pill.popover.detail": "View details →",
      "pill.popover.plan": "Token Plan",
      "pill.popover.payg": "Pay-as-you-go",
      "pill.popover.foreign": "Non-MiMo ({providers})",
      "pill.tip.mixed": "Plus {tokens} tokens via non-MiMo providers ({providers}), excluded above",
      "view.label": "MiMo Usage",
      "view.title": "MiMo usage & quota",
      "view.refresh": "Refresh",
      "view.loading": "Loading…",
      "view.official": "Source: Xiaomi MiMo official API",
      "view.local": "Source: local estimate (official API unavailable)",
      "view.billing.plan": "Billing · Token Plan subscription",
      "view.billing.payg": "Billing · pay-as-you-go",
      "view.billing.unknown": "Billing (no request in this session yet)",
      "view.model": "Current model",
      "view.plan": "Plan quota",
      "view.planCode": "Plan",
      "view.periodEnd": "Period ends",
      "view.expired": "expired",
      "view.balanceNote": "Token Plan quotas and pay-as-you-go balance are not interchangeable, so a subscription account shows a 0 balance here — this is expected.",
      "view.usedPercent": "Used this month",
      "view.remainPercent": "Remaining",
      "view.used": "Used",
      "view.limit": "Limit",
      "view.balance": "Balance",
      "view.cash": "Cash",
      "view.gift": "Gift",
      "view.session": "Current session",
      "view.tokens": "Tokens",
      "view.calls": "Calls",
      "view.input": "Input",
      "view.output": "Output",
      "view.cacheRead": "Cache hit",
      "view.breakdown": "By model",
      "view.today": "Tokens today",
      "view.month": "Tokens this month",
      "view.stats": "Usage stats (local)",
      "view.forecast": "Forecast",
      "view.avgDaily": "Avg / day ({days}d)",
      "view.projected": "Projected month",
      "view.projectedRemain": "Projected left",
      "view.todayRate": "Today's rate (thin sample)",
      "view.thinSample": "Fewer than 3 completed days: forecast is indicative only (today excluded from the average).",
      "view.charge": "Charge (est.)",
      "view.chargeNote": "Token Plan calls consume quota only, with no extra charge.",
      "view.chargeEst": "Session cost (estimated)",
      "view.chargeMixNote": "This session mixed non-MiMo providers. The per-provider breakdown only has totals, not input/output splits, so the cost is prorated by token share — indicative only.",
      "view.mixed": "This session also used non-MiMo providers (excluded from the totals above):",
      "view.mixedTotal": "{tokens} tokens total",
      "view.callsUnit": "calls",
      "view.noBreakdown": "No per-provider breakdown for this session (older counter or degraded stats). The figures above are session-wide and may include non-MiMo providers.",
      "view.notMimo": "not MiMo",
      "view.modelSelected": "(currently selected)",
      "view.noMimoTitle": "This session has not used MiMo yet",
      "view.noMimoBody": "The zero session usage above is expected — this session only used {providers}. The plan quota below is account-level and unrelated to this session.",
      "view.notMimoModel": "The current model belongs to {provider}, not MiMo — the plan quota below is MiMo account-level and does not follow the current model.",
      "view.noData": "No data",
      "view.priceMissing": "No price configured; estimated at 0",
      "view.src.official": "official",
      "view.src.local": "local",
      "view.updated": "Updated",
      // —— settings form ——
      "cfg.title": "MiMo quota settings",
      "cfg.hint": "The cookie reads your Xiaomi official plan quota; leave it empty to use the local estimate. It is stored only in this machine's settings.yaml and is never sent back to the browser.",
      "cfg.cookie": "MiMo console cookie",
      "cfg.cookiePlaceholder": "api-platform_serviceToken=...; userId=...",
      "cfg.cookieConfigured": "Configured ({source})",
      "cfg.cookieEmpty": "Not configured",
      "cfg.cookieKeep": "Leave empty to keep unchanged",
      "cfg.clearCookie": "Clear the saved cookie",
      "cfg.planTotal": "Local fallback plan total (tokens/month)",
      "cfg.pillPosition": "Quota pill position",
      "cfg.pos.header": "Title row (right of Chat / Trajectory)",
      "cfg.pos.toolbar": "Composer toolbar",
      "cfg.pos.above": "Above the composer",
      "cfg.pos.hidden": "Do not show the pill",
      "cfg.wrapToolbar": "Let the composer toolbar wrap (prevents tool icons from overlapping)",
      "cfg.save": "Save",
      "cfg.saving": "Saving…",
      "cfg.saved": "Saved",
      "cfg.saveFailed": "Save failed: {error}",
      "cfg.readonly": "Settings are read-only here (the settings service is not mounted).",
      "cfg.cookieHelp": "How to get it: sign in at platform.xiaomimimo.com → DevTools → Network → any /api/v1 request → copy the full Cookie request header (must include api-platform_serviceToken and userId).",
      "cfg.paste": "Paste",
      "cfg.pasteDone": "Filled from clipboard (remember to Save)",
      "cfg.pasteFail": "Clipboard unavailable — press Ctrl+V manually or right-click paste",
      "cfg.cookieWhy": "This cookie reads your **Token Plan** quota: both tokenPlan/detail and tokenPlan/usage require it. Pay-as-you-go balance lives on the same API domain. Without it, only the local estimate is available.",
    };

    // 由 apply 注入的本地化函数；未注册时退化为按浏览器语言直查
    let boundT = null;
    function t(key, params) {
      if (boundT) {
        try {
          return boundT(key, params);
        } catch {
          /* 落到内置字典 */
        }
      }
      const lang =
        typeof navigator !== "undefined" && navigator.language ? navigator.language.toLowerCase() : "zh";
      const dict = lang.startsWith("zh") ? zh : en;
      let str = dict[key] ?? zh[key] ?? key;
      if (params) for (const [name, value] of Object.entries(params)) str = str.replace(`{${name}}`, String(value));
      return str;
    }

    function fmtCompact(n) {
      if (!Number.isFinite(n) || n <= 0) return "0";
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(Math.round(n));
    }
    const fmtFull = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "0");
    const fmtPercent = (p) => (!Number.isFinite(p) ? "0" : p >= 10 ? p.toFixed(1) : p.toFixed(2));
    function fmtCost(c) {
      if (!Number.isFinite(c) || c <= 0) return "0.00";
      if (c < 0.01) return c.toFixed(4);
      if (c < 1) return c.toFixed(3);
      return c.toFixed(2);
    }

    /** 判断一个 provider 是否属于 MiMo 通道（与胶囊可见性同一规则）。 */
    const isMiMoProviderName = (p) => typeof p === "string" && /mimo/i.test(p);

    /**
     * 把一个会话的用量**按渠道归属拆开**。
     *
     * 为什么需要：一个会话可以先后换过模型 —— 实测某个会话
     * `mimo 49.8M/367calls` + `codebuddy 89.1M/414calls`，总计 138.8M。
     * 早期版本直接把总计当成"MiMo 用量"显示，于是：
     *   ① 汇总数字虚高（把别的渠道算进 MiMo 账上）
     *   ② 会话费用按 MiMo 单价乘**全部** tokens，严重高估
     * 所以汇总必须以**渠道归属**为准，非 MiMo 的部分单独标注但不计入。
     *
     * 归一化处理：`models` 可能缺失（老计数器 / 端点降级），此时无法归属，
     * 退回「整体当作 MiMo」并标记 `attributed:false`，由 UI 提示"未细分渠道"，
     * 而不是显示一个 0 —— 宁可少精确，也不要凭猜测把用户的数据抹掉。
     *
     * @param {object|null} session - /session 端点返回
     * @returns {object|null} 归属结果；session 为空时返回 null
     */
    function splitSessionByProvider(session) {
      if (!session) return null;
      const models = Array.isArray(session.models) ? session.models : [];
      const hasBreakdown = models.length > 0;
      if (!hasBreakdown) {
        // 没有分渠道明细：只能整体归属，并明确标注"未细分"
        return {
          attributed: false,
          total: Number(session.totalTokens) || 0,
          calls: Number(session.calls) || 0,
          mimo: {
            tokens: Number(session.totalTokens) || 0,
            calls: Number(session.calls) || 0,
            models: [],
          },
          other: { tokens: 0, calls: 0, models: [] },
          others: [],
        };
      }
      const pick = (list) =>
        list.reduce(
          (acc, m) => {
            acc.tokens += Number(m.totalTokens) || 0;
            acc.calls += Number(m.calls) || 0;
            return acc;
          },
          { tokens: 0, calls: 0 },
        );
      const mimoModels = models.filter((m) => isMiMoProviderName(m.provider));
      const otherModels = models.filter((m) => !isMiMoProviderName(m.provider));
      const mimo = pick(mimoModels);
      const other = pick(otherModels);
      // 按 provider 归并非 MiMo 部分（同一 provider 可能有多个模型）
      const byProvider = new Map();
      for (const m of otherModels) {
        const key = m.provider || "(unknown)";
        const cur = byProvider.get(key) ?? { provider: key, tokens: 0, calls: 0, models: [] };
        cur.tokens += Number(m.totalTokens) || 0;
        cur.calls += Number(m.calls) || 0;
        cur.models.push(m);
        byProvider.set(key, cur);
      }
      return {
        attributed: true,
        total: Number(session.totalTokens) || 0,
        calls: Number(session.calls) || 0,
        mimo: { ...mimo, models: mimoModels },
        other: { ...other, models: otherModels },
        others: [...byProvider.values()].sort((a, b) => b.tokens - a.tokens),
      };
    }

    /**
     * 会话的**MiMo 归属 token 数** —— 胶囊、弹出卡、详情页汇总统一用它，
     * 避免各处算法漂移（这是"数字不一致"类 bug 的常见来源）。
     * 未细分渠道时退回总数。
     */
    function mimoSessionTokens(session, summary) {
      const split = splitSessionByProvider(session);
      if (split) return split.mimo.tokens;
      return Number(summary?.sessionTokens) || 0;
    }

    /**
     * 计费类型（浏览器半侧判定，弹窗与详情页共用）。
     *
     * ⚠ 为什么不能直接读 `summary.billingType`：host 的 summary 有 **60s 缓存**，
     * 而弹窗的**可见性门读的是实时投影**（`modelSelection`）。于是切模型后的窗口期
     * 会出现"环已经切过去了，计费行还停在上一个渠道" —— 用户实测反馈
     * 「切回 mimo 后胶囊又变回按量付费」，就是 summary 里还留着 codebuddy 时代的 payg。
     *
     * ✅ provider 一致（或拿不到选中模型）→ 信 host；**不一致 → 按 host 同一套规则
     *    本地重算**（name / planStatus 两条信号），保证这段窗口期显示正确的计费类型。
     *    调用方同时会强制刷新拿权威值（见 pill 里 selectedProvider 变化的 effect）。
     *
     * 注意：本地拿不到 `billingTypeOverrides` 与"别的 provider 的 baseURL"，
     * 所以这两条信号只由 host 判；但那两条只影响同一 provider 的结论，
     * 而本函数只在 provider **不同**时才走本地分支。
     *
     * @param {object|null} summary - /summary 返回
     * @param {string} [selectedProvider] - 当前选中的 provider（投影优先）
     * @returns {"token-plan"|"payg"}
     */
    function billingTypeForSelection(summary, selectedProvider) {
      const fromHost = summary?.billingType ?? "token-plan";
      if (!selectedProvider || !summary?.provider || summary.provider === selectedProvider) {
        return fromHost;
      }
      // 以下为 host billingTypeFor 的同规则降级（省略 overrides/baseURL 两条）
      if (/token-plan/i.test(selectedProvider)) return "token-plan";
      if (/mimo/i.test(selectedProvider)) {
        const status = summary.planStatus;
        return status === "expired" || status === "none" ? "payg" : "token-plan";
      }
      return "payg";
    }

    /** 宿主 JSON 端点。 */
    /**
     * 调用插件宿主端点。
     * @param {string} endpoint - summary / session / settings
     * @param {object} [args] - 查询参数
     * @param {string} [method] - 默认 GET；传 POST/PUT 时 args 作为 JSON 请求体
     * @param {object} [body] - 请求体
     */
    async function rpc(endpoint, args, method = "GET", body) {
      const init = { method, headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" };
      // 刻意不用 `/api/*`：DSH 核心对 /api 有严格 Host/Origin fence，
      // 经 fnOS nginx 访问时 Host 被改写成 localhost、Origin 是实际域名，
      // 两者永不相等 → 403。非 /api 前缀没有该 fence。
      // 路径必须经 gatewayPath 补 fnOS 网关前缀，否则经网关访问会 404/405。
      let url = gatewayPath(`${ROUTE_PREFIX}/${endpoint}`);
      if (method === "GET") {
        if (args) url += `?${new URLSearchParams(args)}`;
      } else if (body !== undefined) {
        init.headers = { ...init.headers, "content-type": "application/json" };
        init.body = JSON.stringify(body);
      } else if (args !== undefined) {
        init.headers = { ...init.headers, "content-type": "application/json" };
        init.body = JSON.stringify(args);
      }
      // ⚠ 用 pingFetch 而不是裸 `fetch`：动态插件浏览器半里裸 fetch 是抛错陷阱
      const res = await pingFetch(url, init);
      const payload = await res.json().catch(() => ({}));
      if (payload.ok) return payload.data;
      throw new Error(payload.error ?? `HTTP ${res.status}`);
    }

    /**
     * 切到「MiMo 用量」详情页。
     * 宿主并未向 header.actions 注入 selectView，因此优先点击同名 tab 按钮
     * （标签行由 conversation.view 注册表渲染），并保留 openView/selectView 兜底。
     * @returns {boolean} 是否已触发切换
     */
    function activateMimoView(props) {
      const direct = props?.selectView ?? props?.openView;
      if (typeof direct === "function") {
        try {
          direct("mimo-usage", "");
          return true;
        } catch {
          /* 落到 DOM 回退 */
        }
      }
      if (typeof document === "undefined") return false;
      const labels = [zh["view.label"], en["view.label"]];
      for (const tab of document.querySelectorAll('[role="tablist"] [role="tab"]')) {
        if (labels.includes((tab.textContent ?? "").trim())) {
          tab.click();
          return true;
        }
      }
      return false;
    }

    // ── 响应式：监听视口宽度 ──────────────────────────────────────────
    // 竖屏手机（<640px）与平板/桌面采用不同布局；用 matchMedia 订阅而非一次性读取，
    // 这样横竖屏切换、窗口拖动都会实时重排。
    function useViewport() {
      const read = () => {
        if (typeof window === "undefined") return { narrow: false, width: 1024 };
        const w = window.innerWidth || 1024;
        return { narrow: w < 640, width: w };
      };
      const [vp, setVp] = useState(read);
      useEffect(() => {
        if (typeof window === "undefined") return;
        const onResize = () => setVp(read());
        window.addEventListener("resize", onResize);
        window.addEventListener("orientationchange", onResize);
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 639px)") : null;
        if (mq && typeof mq.addEventListener === "function") mq.addEventListener("change", onResize);
        return () => {
          window.removeEventListener("resize", onResize);
          window.removeEventListener("orientationchange", onResize);
          if (mq && typeof mq.removeEventListener === "function") mq.removeEventListener("change", onResize);
        };
      }, []);
      return vp;
    }

    /** 全局共享的 UI 偏好（由 summary 拉取，胶囊与详情页共用）。 */
    const uiPrefs = { position: "header", wrapToolbar: true, loaded: false, listeners: new Set() };
    function setUiPrefs(next) {
      const changed = uiPrefs.position !== next.position || uiPrefs.wrapToolbar !== next.wrapToolbar;
      uiPrefs.position = next.position;
      uiPrefs.wrapToolbar = next.wrapToolbar;
      uiPrefs.loaded = true;
      if (changed) for (const fn of [...uiPrefs.listeners]) {
        try {
          fn();
        } catch {
          /* 单个监听器异常不影响其它 */
        }
      }
    }
    function useUiPrefs() {
      const [, force] = useState(0);
      useEffect(() => {
        const fn = () => force((n) => n + 1);
        uiPrefs.listeners.add(fn);
        return () => uiPrefs.listeners.delete(fn);
      }, []);
      return { position: uiPrefs.position, wrapToolbar: uiPrefs.wrapToolbar, loaded: uiPrefs.loaded };
    }

    /**
     * mimo 额度胶囊：**mi logo + 用量环**，点击弹出用量摘要。
     *
     * 视觉参照 dsh-codebuddy 的模型旁用量环（环内嵌品牌 logo、无文字）。
     * 与它的差异：
     *   - 按量付费**没有总量**，percent 传 null → 只画空环（codebuddy 有 limit 可算）
     *   - 点击不是切详情页，而是弹一个小卡片显示「计费类型 + 用量」，
     *     卡片里再给「查看详情」入口（保留原有跳详情页能力）
     */
    function MimoPill(props) {
      const sessionId = props?.sessionId ?? "";
      const compact = props?.compact === true;
      const [summary, setSummary] = useState(null);
      const [session, setSession] = useState(null);
      const [failed, setFailed] = useState(false);
      const [open, setOpen] = useState(false);
      const epochRef = useRef(0);
      const rootRef = useRef(null);

      /**
       * 拉取 summary。
       * @param {boolean} [force] - true 时带 refresh=1 绕过 host 的 60s 缓存
       *   （选中模型刚变时必须传，否则拿到的是上一个渠道的计费类型）
       */
      const refresh = useCallback(async (force) => {
        const epoch = ++epochRef.current;
        try {
          const data = await rpc("summary", force ? { refresh: "1" } : undefined);
          if (epoch !== epochRef.current) return;
          setSummary(data);
          setFailed(false);
          // summary 携带 UI 偏好：同步到共享状态，供其它位置的胶囊/详情页感知
          if (data?.ui) setUiPrefs({ position: data.ui.pillPosition ?? "header", wrapToolbar: data.ui.wrapToolbar !== false });
        } catch {
          if (epoch === epochRef.current) setFailed(true);
          return;
        }
        if (!sessionId) return;
        try {
          const s = await rpc("session", { id: sessionId });
          if (epoch === epochRef.current) setSession(s);
        } catch {
          /* 会话端点缺失不影响胶囊 */
        }
      }, [sessionId]);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 60_000);
        const onVisible = () => {
          if (!document.hidden) refresh();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, [refresh]);

      // 点击外部 / Esc 关闭弹出卡
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("pointerdown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      // ── 可见性：只在当前模型属于 MiMo 时显示 ──────────────────────────
      // 与 dsh-codebuddy 同一机制（它的 codebuddyUsageVisible 读会话投影
      // `modelSelection` 的 next/lastUsed.provider）。理由：额度环绑定的是
      // MiMo 通道，用别的 provider 时显示会造成"明明没用 MiMo 却在报 MiMo 额度"
      // 的误导 —— 用户实测反馈过这一点。
      //
      // 取不到投影时（老版本平台 / 投影缺失）**保持显示**：宁可多显示，
      // 也不要因为读不到就把功能静默关掉。
      // ── 读「当前选中的模型」 ──────────────────────────────────────────
      // ⚠ 必须用会话投影 `modelSelection`，**不能只靠 summary.provider/model**：
      // host 侧 modelTracker 记的是"最近一次请求用过什么"（从 session 事件 /
      // 计数器快照挑 last.provider），而且一旦设定就**永久缓存** —— 切到 mimo 后
      // 它仍停在旧值（用户实测：弹窗里显示的还是 deepseek）。
      // codebuddy 同样读 `modelSelection.next/lastUsed`，这是唯一与选中模型同源的来源。
      const selected = (() => {
        try {
          if (typeof props?.useProjection !== "function") return null;
          const projection = props.useProjection("modelSelection");
          const hit = projection?.next ?? projection?.lastUsed;
          if (!hit) return null;
          const p = typeof hit.provider === "string" && hit.provider ? hit.provider : undefined;
          const m = typeof hit.model === "string" && hit.model ? hit.model : undefined;
          return p || m ? { provider: p, model: m } : null;
        } catch {
          return null;
        }
      })();
      // 投影缺失时才退回 summary（它是"最近一次真实请求"的归属）
      const selectedProvider = selected?.provider ?? (summary?.provider || undefined);
      const providerIsMiMo = selectedProvider === undefined ? true : /mimo/i.test(selectedProvider);
      // 弹窗「当前模型」显示的值：投影优先
      const selectedModelLabel = (() => {
        if (selected?.provider && selected?.model) return `${selected.provider}/${selected.model}`;
        if (selected?.model) return selected.model;
        if (summary?.provider && summary?.model) return `${summary.provider}/${summary.model}`;
        if (summary?.model) return summary.model;
        return null;
      })();
      // 模型是否来自"当前选中"（而非最近一次请求）—— 供 UI 标注来源
      const modelFromSelection = Boolean(selected?.model);

      // ⚠ 选中 provider 一变就**强制**刷新一次（绕过 host 60s 缓存）。
      // 否则可见性门（实时投影）已把环切到 mimo，计费行却还在读 codebuddy 时代的
      // 缓存 → 用户看到"切回 mimo 后胶囊又变回按量付费"。首帧跳过（mount 已拉过）。
      // 本 effect 必须留在 `if (!providerIsMiMo) return null` 之前 —— hook 顺序规则。
      const seenProviderRef = useRef(selectedProvider);
      useEffect(() => {
        if (seenProviderRef.current === selectedProvider) return; // 含首帧
        seenProviderRef.current = selectedProvider;
        if (selectedProvider) refresh(true);
      }, [selectedProvider, refresh]);

      // ── 弹层定位：createPortal + 真实尺寸测量 + 双向钳制 ────────────────
      //
      // ⚠ 历史坑（用户两次反馈"弹窗在屏幕外/显示不全"）：
      //   ① 最初用 `position:absolute; right:0` 挂在环上 —— 环在输入框工具栏
      //      最右侧，弹窗向右对齐直接溢出屏幕；祖先的 `overflow:hidden` 还会裁掉它。
      //      胶囊放到**标题栏**时同样越界（标题栏贴顶，向上弹出会跑出屏幕）。
      //   ② 第二版改成 `position:fixed` + **估算**尺寸（height 硬编码 200）——
      //      估算不准会让上下翻转判断出错，仍可能越界。
      //
      // ✅ 正确做法（平台自己的 Tooltip 原语就是这么做的）：
      //   **用 react-dom 的 `createPortal` 挂到 `document.body`**
      //   （`react-dom` 在平台 seed 表里，插件可直接 require），
      //   彻底脱离所有祖先的 overflow / transform / z-index 上下文；
      //   挂载后**测量真实尺寸**，再按真实高度决定"向上"还是"向下"。
      //   平台 Tooltip 的定位核心同为：createPortal + innerWidth/innerHeight 钳制
      //   + 上下翻转。
      //
      // 定位放 layout effect：先以 visibility:hidden 量尺寸再落位，避免"闪一下再跳"；
      // resize / 滚动时重算（标题栏会随滚动移动）。
      const popRef = useRef(null);
      const [popPos, setPopPos] = useState(null);

      const placePopover = useCallback(() => {
        const anchor = rootRef.current;
        const pop = popRef.current;
        if (!anchor || !pop || typeof anchor.getBoundingClientRect !== "function") return;
        const a = anchor.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 360;
        const vh = window.innerHeight || document.documentElement.clientHeight || 640;
        const M = 8; // 与视口边缘的安全间距
        const width = Math.min(260, Math.max(180, vw - M * 2));
        const height = p.height > 0 ? p.height : 200; // 真实高度，量不到才退回估算
        // 水平：优先与锚点右对齐 → 越界左移 → 仍越界贴左
        let left = a.right - width;
        if (left + width > vw - M) left = vw - M - width;
        if (left < M) left = M;
        // 垂直：优先上方；上方放不下则下方；都不够时选宽敞的一侧，再整体夹进视口
        const spaceAbove = a.top - M;
        const spaceBelow = vh - a.bottom - M;
        const need = height + 8;
        let top;
        if (spaceAbove >= need) top = a.top - height - 8;
        else if (spaceBelow >= need) top = a.bottom + 8;
        else top = spaceBelow >= spaceAbove ? a.bottom + 8 : a.top - height - 8;
        if (top < M) top = M;
        if (top + height > vh - M) top = Math.max(M, vh - M - height);
        setPopPos({ left, top, width, maxHeight: Math.max(160, vh - M * 2) });
      }, []);

      useEffect(() => {
        if (!open) {
          setPopPos(null);
          return undefined;
        }
        placePopover();
        const raf =
          typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(placePopover) : 0;
        window.addEventListener("resize", placePopover);
        window.addEventListener("scroll", placePopover, true);
        return () => {
          if (raf && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(raf);
          window.removeEventListener("resize", placePopover);
          window.removeEventListener("scroll", placePopover, true);
        };
      }, [open, placePopover]);

      if (!providerIsMiMo) return null;

      // 用共享判定：与实时选中的 provider 对齐（详见 billingTypeForSelection）
      const billingType = billingTypeForSelection(summary, selectedProvider);
      const unit = summary?.planUsage?.items?.[0] ?? null;
      const remainPercent = unit ? Math.max(0, 100 - unit.percent) : null;
      const isPlan = billingType === "token-plan";

      // ⚠ 只算**MiMo 归属**的会话用量：一个会话可能换过模型，
      // 把别的渠道算进来会虚高（实测有会话 138.8M 里 89.1M 是 codebuddy）。
      const split = splitSessionByProvider(session);
      const sessionTokens = split ? split.mimo.tokens : summary?.sessionTokens ?? 0;
      const sessionCalls = split ? split.mimo.calls : session?.calls ?? 0;
      const foreignTokens = split?.attributed ? split.other.tokens : 0;
      const foreignProviders = split?.others ?? [];

      // 环进度：套餐 → 剩余百分比；按量 → null（只画空环，因为没有"总量"）
      const ringPercent = !summary ? null : isPlan ? remainPercent : null;

      // 悬停/无障碍说明
      let title;
      if (!summary) {
        title = failed ? t("pill.tip.error") : t("pill.tip.loading");
      } else if (isPlan) {
        title = t("pill.tip.plan", {
          source: summary.official ? t("view.src.official") : t("view.src.local"),
          used: unit ? fmtPercent(unit.percent) : "—",
        });
      } else {
        title = t("pill.tip.payg", {
          tokens: fmtFull(sessionTokens),
          calls: split ? ` · ${split.mimo.calls} calls` : "",
        });
        // 会话里混了别的渠道 → 明说，避免用户以为这个数字是全部消耗
        if (foreignTokens > 0) {
          title += `\n${t("pill.tip.mixed", {
            tokens: fmtCompact(foreignTokens),
            providers: foreignProviders.map((o) => o.provider).join(" / "),
          })}`;
        }
      }

      // 弹出卡里的一行
      const line = (label, value, strong) =>
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "baseline" } },
          h("span", { style: { color: "var(--dsw-alias-label-tertiary, #59636e)", fontSize: "11px" } }, label),
          h(
            "span",
            {
              style: {
                fontSize: strong ? "13px" : "12px",
                fontWeight: strong ? 650 : 500,
                fontVariantNumeric: "tabular-nums",
                color: "var(--dsw-alias-label-primary, #1f2328)",
              },
            },
            value,
          ),
        );


      const popoverBody = open
        ? h(
            "div",
            {
              ref: popRef,
              // stopPropagation：点卡片内部不应触发"点击外部关闭"
              onPointerDown: (event) => event.stopPropagation(),
              style: popPos
                ? {
                    // fixed + portal：双重保险。portal 已脱离裁剪上下文，
                    // fixed 让 left/top 以视口为基准（与 placePopover 的计算一致）。
                    position: "fixed",
                    left: `${popPos.left}px`,
                    top: `${popPos.top}px`,
                    width: `${popPos.width}px`,
                    maxHeight: `${popPos.maxHeight}px`,
                    overflowY: "auto",
                    zIndex: 2147483000, // 压过平台自身的浮层
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    boxSizing: "border-box",
                    background: "var(--dsw-alias-bg-overlay, #fff)",
                    border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))",
                    borderRadius: "10px",
                    boxShadow: "0 6px 24px rgba(0,0,0,.14)",
                    cursor: "default",
                  }
                : // 首帧还没量到位置：可见但不可见地先渲染，好让 getBoundingClientRect 拿到真实尺寸
                  {
                    position: "fixed",
                    visibility: "hidden",
                    left: 0,
                    top: 0,
                    width: "260px",
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    boxSizing: "border-box",
                  },
              role: "dialog",
              "aria-label": t("pill.popover.title"),
            },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" } },
              h(MiLogo, { size: 13 }),
              h(
                "b",
                { style: { fontSize: "12px", fontWeight: 650, color: "var(--dsw-alias-label-primary, #1f2328)" } },
                t("pill.label"),
              ),
            ),
            line(
              t("pill.popover.billing"),
              isPlan ? t("pill.popover.plan") : t("pill.popover.payg"),
              true,
            ),
            isPlan
              ? line(t("pill.popover.remain"), remainPercent !== null ? `${fmtPercent(remainPercent)}%` : "—", true)
              : line(t("pill.popover.session"), fmtCompact(sessionTokens), true),
            isPlan && unit ? line(t("pill.popover.used"), `${fmtPercent(unit.percent)}%`) : null,
            isPlan && unit ? line(t("pill.popover.total"), fmtFull(unit.limit ?? 0)) : null,
            // 套餐模式下也把会话的 MiMo 用量列出来 —— 否则用户看不到"这个会话消耗了多少"
            isPlan && split ? line(t("pill.popover.session"), fmtCompact(sessionTokens)) : null,
            summary && !isPlan && split ? line(t("pill.popover.calls"), String(split.mimo.calls)) : null,
            // 会话里混了别的渠道：单独一行说明，不计入上面的 MiMo 数字
            foreignTokens > 0
              ? line(
                  t("pill.popover.foreign", { providers: foreignProviders.map((o) => o.provider).join("/") }),
                  fmtCompact(foreignTokens),
                )
              : null,
            // 用投影里的「当前选中模型」；后端 summary 只是兜底。
            // 附来源标记，方便判断显示的是"选中的"还是"最近请求过的"。
            selectedModelLabel
              ? line(
                  modelFromSelection ? t("pill.popover.model") : t("pill.popover.modelLast"),
                  selectedModelLabel,
                )
              : null,
            h(
              "button",
              {
                type: "button",
                onClick: () => {
                  setOpen(false);
                  activateMimoView(props);
                },
                style: {
                  marginTop: "4px",
                  padding: "5px 8px",
                  fontSize: "11px",
                  borderRadius: "7px",
                  border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))",
                  background: "transparent",
                  color: "var(--dsw-alias-label-primary, #1f2328)",
                  cursor: "pointer",
                },
              },
              t("pill.popover.detail"),
            ),
          )
        : null;

      // 用 portal 把弹层挂到 document.body —— 根治"被祖先 overflow 裁掉"；
      // 拿不到 createPortal 时退化为就地渲染（外层的 overflow 仍可能裁剪，
      // 但位置计算照旧，至少不会跑到屏幕外）。
      const popover =
        popoverBody && createPortal && typeof document !== "undefined"
          ? createPortal(popoverBody, document.body)
          : popoverBody;

      return h(
        "span",
        {
          ref: rootRef,
          role: "button",
          tabIndex: 0,
          title,
          "aria-label": `${t("pill.label")} ${title}`,
          "aria-expanded": open,
          style: {
            // 环形态：去掉胶囊的边框/底色/内边距，只留一个可点的环
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            opacity: failed && !summary ? 0.5 : 1,
            flex: "none",
            ...(compact ? { padding: "2px" } : { padding: "1px" }),
          },
          onClick: () => {
            setOpen((v) => !v);
            if (!open) refresh();
          },
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen((v) => !v);
            }
          },
        },
        // 尺寸固定为 RING_SIZE（26），**不随 compact/narrow 缩小** ——
        // 用户要求与 dsh-codebuddy 的环大小一致；两者并排时若一个 20 一个 26
        // 会明显不齐。紧凑场景靠去掉内边距解决，不改环本身。
        h(UsageRing, {
          percent: ringPercent,
          size: RING_SIZE,
          strokeWidth: RING_STROKE,
          title,
        }),
        popover,
      );
    }

    /**
     * 小米（mi）官方 logo，内联 SVG —— 供用量环中心显示。
     *
     * 路径取自 simple-icons（业界广泛使用的官方 shape 复刻，viewBox 0 0 24 24）：
     * https://github.com/simple-icons/simple-icons/blob/develop/icons/xiaomi.svg
     * 不引入任何依赖，纯 path，避免为一个图标打包整套组件库。
     *
     * 配色对齐 dsh-codebuddy 的 `variant="mono"`：
     *   底色 var(--dsw-alias-brand-primary) / 图形 var(--dsw-alias-label-primary-foreground)
     * 这两个变量由平台（dsh-web-frontend）定义，因此在任何主题下都自动一致。
     */
    const MI_LOGO_PATH =
      "M12 0C8.016 0 4.756.255 2.493 2.516.23 4.776 0 8.033 0 12.012c0 3.98.23 7.235 2.494 9.497C4.757 23.77 8.017 24 12 24c3.983 0 7.243-.23 9.506-2.491C23.77 19.247 24 15.99 24 12.012c0-3.984-.233-7.243-2.502-9.504C19.234.252 15.978 0 12 0zM4.906 7.405h5.624c1.47 0 3.007.068 3.764.827.746.746.827 2.233.83 3.676v4.54a.15.15 0 0 1-.152.147h-1.947a.15.15 0 0 1-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15 0 0 0-.151.147v6.98a.15.15 0 0 1-.152.148H4.906a.15.15 0 0 1-.15-.148V7.554a.15.15 0 0 1 .15-.149zm12.131 0h1.949a.15.15 0 0 1 .15.15v8.892a.15.15 0 0 1-.15.148h-1.949a.15.15 0 0 1-.151-.148V7.554a.15.15 0 0 1 .151-.149zM8.92 10.948h2.046c.083 0 .15.066.15.147v5.352a.15.15 0 0 1-.15.148H8.92a.15.15 0 0 1-.152-.148v-5.352a.15.15 0 0 1 .152-.147Z";

    /**
     * 环的尺寸常量 —— **必须与 dsh-codebuddy 完全一致**，否则两个插件并排时
     * 大小不一（用户实测反馈过这个问题）。
     *
     * codebuddy 的值（`Progress type="circle"` 的参数，见其 client.js）：
     *   width = 26, strokeWidth = 3
     * 它给中心 logo 的 size 是 12。
     * 这些数字是硬约束，改动前请先核对 codebuddy 是否也变了。
     */
    const RING_SIZE = 26;
    const RING_STROKE = 3;
    /** 中心 logo 尺寸（对齐 codebuddy 的 `CodeBuddyLogo size={12}`）。 */
    const RING_LOGO_SIZE = 12;

    /**
     * mi logo 的填充色 = 小米品牌橙。
     *
     * ⚠ **不要**改回 `var(--dsw-alias-brand-primary)`：本机主题把该变量定义成
     * `#0f1115`（近黑），环里的 logo 会变成一团看不清的黑块（实测计算值
     * `rgb(15,17,21)`）。品牌 logo 应当固定用品牌色 —— codebuddy 也是这个策略，
     * 它的 `CodeBuddyLogo` 在 `variant="brand"`（默认）下写死 `#6C4DFF`，
     * 只有 `mono` 变体才用主题变量。
     */
    const MI_LOGO_FILL = "#ff6900";

    /** mi logo 尺寸。 */
    function MiLogo({ size = RING_LOGO_SIZE }) {
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block", flex: "none" },
        },
        h("path", { d: MI_LOGO_PATH, fill: MI_LOGO_FILL }),
      );
    }

    /**
     * 用量环：SVG 双圈（底圈 + 进度圈），中心嵌 mi logo。
     *
     * 参照 dsh-codebuddy 的 `Progress type="circle" width={26} strokeWidth={3}`
     * （它用 @douyinfe/semi-ui，不在平台 seed 表里，所以这里手写等价实现）：
     *   底圈 orbitStroke = var(--dsw-alias-border-l3)
     *   进度圈 stroke   = var(--dsw-alias-label-tertiary)
     *   进度从 12 点方向顺时针。
     *
     * **按量付费没有"总量"概念，percent 传 null → 只画底圈（空环）**，
     * 避免画出一个永远 0% 或 100% 的误导性圆环。
     *
     * @param {object} props
     * @param {number|null} props.percent 0~100；null = 无进度（按量），只画空环
     * @param {number} [props.size] 直径 px
     * @param {number} [props.strokeWidth] 环宽 px
     * @param {string} [props.title] 无障碍/悬停说明
     */
    function UsageRing({ percent, size = RING_SIZE, strokeWidth = RING_STROKE, title }) {
      const r = (size - strokeWidth) / 2;
      const c = 2 * Math.PI * r;
      const hasProgress = typeof percent === "number" && Number.isFinite(percent);
      const clamped = hasProgress ? Math.max(0, Math.min(100, percent)) : 0;
      const dash = (clamped / 100) * c;
      const cx = size / 2;
      return h(
        "span",
        {
          style: {
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: size,
            height: size,
            flex: "none",
          },
          "aria-label": title,
          role: "img",
        },
        h(
          "svg",
          { width: size, height: size, viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true", style: { display: "block" } },
          // 底圈（轨道）
          h("circle", {
            cx,
            cy: cx,
            r,
            fill: "none",
            stroke: "var(--dsw-alias-border-l3, rgba(127,127,127,.35))",
            strokeWidth,
          }),
          // 进度圈：only 在有总量时才画
          hasProgress
            ? h("circle", {
                cx,
                cy: cx,
                r,
                fill: "none",
                stroke: "var(--dsw-alias-label-tertiary, #59636e)",
                strokeWidth,
                strokeLinecap: "round",
                strokeDasharray: `${dash} ${c - dash}`,
                // 从 12 点方向开始，顺时针
                transform: `rotate(-90 ${cx} ${cx})`,
              })
            : null,
        ),
        // 中心嵌 mi logo：定位在环内，不参与环的绘制
        h(
          "span",
          {
            style: {
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            },
          },
          h(MiLogo, { size: RING_LOGO_SIZE }),
        ),
      );
    }

    function Card({ title, children }) {
      return h(
        "section",
        {
          style: {
            background: "var(--dsw-alias-bg-overlay, #fff)",
            border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))",
            borderRadius: "12px",
            padding: "16px",
            minWidth: 0,
          },
        },
        title
          ? h(
              "h3",
              {
                style: {
                  margin: "0 0 10px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--dsw-alias-label-secondary, #59636e)",
                },
              },
              title,
            )
          : null,
        children,
      );
    }

    function Stat({ label, value, accent }) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "96px" } },
        h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } }, label),
        h(
          "span",
          {
            style: {
              fontSize: "17px",
              fontWeight: 650,
              fontVariantNumeric: "tabular-nums",
              color: accent
                ? "var(--dsw-alias-state-business-primary, #0969da)"
                : "var(--dsw-alias-label-primary, #1f2328)",
            },
          },
          value,
        ),
      );
    }

    const Row = ({ children }) =>
      h("div", { style: { display: "flex", gap: "20px", flexWrap: "wrap", alignItems: "flex-start" } }, children);

    function Bar({ percent, danger }) {
      return h(
        "div",
        {
          style: {
            height: "8px",
            background: "var(--dsw-alias-bg-layer-2, rgba(120,130,150,.12))",
            borderRadius: "999px",
            overflow: "hidden",
            margin: "10px 0 8px",
          },
        },
        h("div", {
          style: {
            width: `${Math.max(0, Math.min(100, Number(percent) || 0))}%`,
            height: "100%",
            background: danger
              ? "var(--dsw-alias-state-error-primary, #cf222e)"
              : "var(--dsw-alias-state-business-primary, #0969da)",
            transition: "width .35s ease",
          },
        }),
      );
    }

    function MimoUsageView(props) {
      const sessionId = props?.sessionId ?? "";
      const [summary, setSummary] = useState(null);
      const [session, setSession] = useState(null);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(true);
      const epochRef = useRef(0);

      // 当前选中的模型（与胶囊同一来源：会话投影 `modelSelection`）。
      // host 的 summary.provider/model 记的是"最近一次请求"，切模型后会滞后，
      // 所以详情页也优先用投影，summary 只作兜底。
      const currentModel = (() => {
        try {
          if (typeof props?.useProjection !== "function") return null;
          const projection = props.useProjection("modelSelection");
          const hit = projection?.next ?? projection?.lastUsed;
          if (!hit) return null;
          const p = typeof hit.provider === "string" && hit.provider ? hit.provider : undefined;
          const m = typeof hit.model === "string" && hit.model ? hit.model : undefined;
          return p || m ? { provider: p, model: m, fromSelection: true } : null;
        } catch {
          return null;
        }
      })();
      const modelProvider = currentModel?.provider ?? summary?.provider ?? "";
      const modelLabel = (() => {
        if (currentModel) {
          const m = currentModel.model ?? "";
          return m ? `${currentModel.provider ? `${currentModel.provider}/` : ""}${m}` : currentModel.provider ?? "";
        }
        if (summary?.model) return `${summary.provider ? `${summary.provider}/` : ""}${summary.model}`;
        return null;
      })();

      const load = useCallback(
        async (force) => {
          const epoch = ++epochRef.current;
          setLoading(true);
          setError("");
          try {
            const data = await rpc("summary", force ? { refresh: "1" } : undefined);
            if (epoch === epochRef.current) setSummary(data);
          } catch (e) {
            if (epoch === epochRef.current) setError(e instanceof Error ? e.message : String(e));
          } finally {
            if (epoch === epochRef.current) setLoading(false);
          }
          if (!sessionId) return;
          try {
            const s = await rpc("session", { id: sessionId });
            if (epoch === epochRef.current) setSession(s);
          } catch {
            /* 会话端点失败不影响其余数据 */
          }
        },
        [sessionId],
      );

      useEffect(() => {
        load(false);
      }, [load]);

      // 与胶囊同源：选中的 provider 与缓存里的不一致时本地重算（见 helper 注释）
      const billingType = billingTypeForSelection(summary, modelProvider);
      const planUsage = summary?.planUsage ?? null;
      const unit = planUsage?.items?.[0] ?? null;
      const local = summary?.local ?? null;
      const price = summary?.price ?? null;

      const forecast = useMemo(() => {
        const days = local?.days ?? [];
        if (!local?.ok || days.length === 0) return null;
        // 今天尚未结束，计入均值会系统性高估：只用"已完成的天"求日均
        const completed = days.filter((d) => d.date !== local.today);
        const window = completed.slice(-7);
        const sampleDays = window.length;
        const avgDaily = sampleDays > 0
          ? window.reduce((sum, d) => sum + (d.tokens || 0), 0) / sampleDays
          : local.todayTokens; // 只有今天时退化为单日速率，并标注样本不足
        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const remainingDays = Math.max(0, daysInMonth - now.getDate());
        const projectedMonth = local.monthTokens + avgDaily * remainingDays;
        const limit = unit?.limit ?? 0;
        return {
          avgDaily,
          sampleDays,
          thinSample: sampleDays < 3,
          projectedMonth,
          projectedRemain: limit > 0 ? Math.max(0, limit - projectedMonth) : null,
          overBudget: limit > 0 && projectedMonth > limit,
        };
      }, [local, unit]);

      // 会话用量按渠道归属拆分（详见 splitSessionByProvider 的说明）
      const sessionSplit = useMemo(() => splitSessionByProvider(session), [session]);
      // MiMo 归属的 token 数：会话卡汇总用它，而不是 session.totalTokens
      const sessTokens = sessionSplit ? sessionSplit.mimo.tokens : session?.totalTokens ?? 0;
      const sessCalls = sessionSplit ? sessionSplit.mimo.calls : session?.calls ?? 0;
      // 会话里非 MiMo 渠道的消耗（只作提示，不计入任何 MiMo 统计）
      const sessForeign = sessionSplit?.attributed ? sessionSplit.other : null;
      const sessOthers = sessionSplit?.attributed ? sessionSplit.others : [];

      // ⚠ 费用只能按 **MiMo 归属** 的部分算：早期版本用整会话的 input/output
      // 乘 MiMo 单价，会话换过模型时会把别的渠道的消耗也算成 MiMo 花费（严重高估）。
      const sessionCharge = useMemo(() => {
        if (!session || billingType !== "payg" || !price) return null;
        // 无分渠道明细时无法只取 MiMo 部分 → 不给结论，避免报一个偏高的数
        if (sessionSplit && !sessionSplit.attributed) return null;
        const isMimo = (p) => isMiMoProviderName(p);
        const models = Array.isArray(session.models) ? session.models : [];
        if (models.length === 0) return null;
        // 只有单一 MiMo 渠道时，整会话的 input/output 就是 MiMo 的，可精确计算
        const onlyMimo = models.every((m) => isMimo(m.provider));
        if (!onlyMimo) {
          // 混合渠道：models[] 只有 totalTokens，没有 input/output 拆分，
          // 无法精确分摊 → 按 token 占比折算，并在 UI 标注"估算"
          const total = sessionSplit?.total ?? 0;
          const share = total > 0 ? sessTokens / total : 0;
          return (
            ((session.inputTokens || 0) * (price.input || 0) +
              (session.outputTokens || 0) * (price.output || 0) +
              (session.cacheReadTokens || 0) * (price.cacheRead || 0) +
              (session.cacheWriteTokens || 0) * (price.cacheWrite || 0)) /
            1_000_000 *
            share
          );
        }
        return (
          ((session.inputTokens || 0) * (price.input || 0) +
            (session.outputTokens || 0) * (price.output || 0) +
            (session.cacheReadTokens || 0) * (price.cacheRead || 0) +
            (session.cacheWriteTokens || 0) * (price.cacheWrite || 0)) /
          1_000_000
        );
      }, [session, sessionSplit, sessTokens, billingType, price]);
      // 费用是否为折算值（混合渠道时按占比估算）
      const chargeIsEstimated = useMemo(() => {
        const models = Array.isArray(session?.models) ? session.models : [];
        return models.length > 0 && !models.every((m) => isMiMoProviderName(m.provider));
      }, [session]);

      // 响应式：窄屏（竖屏手机）改为单列 + 紧凑间距 + 可横滚表格。
      //
      // ⚠️ 这些 hook 必须在任何提前 return 之前调用：React 要求每次渲染的 hook
      // 调用数量与顺序完全一致，放到 `if (loading) return …` 之后会导致
      // "Rendered more hooks than during the previous render" 崩溃。
      const { narrow } = useViewport();
      const prefs = useUiPrefs();

      if (loading && !summary) {
        return h(
          "div",
          { style: { padding: "24px 22px", color: "var(--dsw-alias-label-secondary, #59636e)", fontSize: "13px" } },
          t("view.loading"),
        );
      }

      const grid = {
        display: "grid",
        // 窄屏强制单列；宽屏按可用宽度自适应列数
        gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fit, minmax(290px, 1fr))",
        gap: narrow ? "10px" : "14px",
      };
      const days = (local?.days ?? []).slice(-14);
      const maxDay = days.length ? Math.max(...days.map((d) => d.tokens), 1) : 1;
      const thStyle = {
        textAlign: "left",
        padding: narrow ? "3px 4px" : "3px 6px",
        color: "var(--dsw-alias-label-secondary, #59636e)",
        fontWeight: 500,
      };
      const tdNum = {
        padding: narrow ? "3px 4px" : "3px 6px",
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      };

      return h(
        "div",
        {
          style: {
            // 窄屏收窄内边距，把宽度让给内容
            padding: narrow ? "12px 12px 96px" : "16px 22px 40px",
            maxWidth: "1100px",
            fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
            fontSize: narrow ? "12px" : "13px",
            color: "var(--dsw-alias-label-primary, #1f2328)",
            boxSizing: "border-box",
            width: "100%",
          },
        },

        // 标题行
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              marginBottom: "8px",
              flexWrap: "wrap",
            },
          },
          h("h2", { style: { margin: 0, fontSize: "17px", fontWeight: 650 } }, t("view.title")),
          h(
            "div",
            { style: { display: "flex", gap: "10px", alignItems: "center" } },
            h(
              "span",
              { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
              summary ? `${t("view.updated")} ${new Date(summary.updatedAt).toLocaleTimeString()}` : "",
            ),
            h(
              "button",
              {
                type: "button",
                onClick: () => load(true),
                style: {
                  border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                  background: "var(--dsw-alias-bg-layer-1, #fff)",
                  borderRadius: "8px",
                  padding: "5px 12px",
                  cursor: "pointer",
                  fontSize: "12px",
                  color: "inherit",
                },
              },
              t("view.refresh"),
            ),
          ),
        ),
        h(
          "div",
          { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)", marginBottom: "14px" } },
          summary?.official ? t("view.official") : summary ? `${t("view.local")} · ${summary.officialError}` : "",
        ),
        error
          ? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #cf222e)", marginBottom: "10px" } }, error)
          : null,

        // 计费类型 + 套餐 + 余额
        h(
          "div",
          { style: grid },
          h(
            Card,
            { title: t("view.model") },
            h(Stat, {
              // provider 未知（本会话还没发过请求）时不给计费结论，避免误标
              label: summary?.providerKnown === false && !currentModel
                ? t("view.billing.unknown")
                : billingType === "token-plan"
                  ? t("view.billing.plan")
                  : t("view.billing.payg"),
              // 优先显示"当前选中"的模型（投影），否则退回最近请求过的
              value: modelLabel ?? t("view.noData"),
              accent: true,
            }),
            currentModel?.fromSelection
              ? h(
                  "div",
                  {
                    style: {
                      marginTop: "4px",
                      fontSize: "11px",
                      color: "var(--dsw-alias-label-tertiary, #59636e)",
                    },
                  },
                  t("view.modelSelected"),
                )
              : null,
            // 当前模型不是 MiMo → 标明"本插件的额度只对 MiMo 生效"，
            // 否则用户会疑惑"为什么这里显示的额度跟我现在用的模型无关"
            modelProvider && !isMiMoProviderName(modelProvider)
              ? h(
                  "div",
                  {
                    style: {
                      marginTop: "8px",
                      fontSize: "11px",
                      lineHeight: 1.6,
                      color: "var(--dsw-alias-label-tertiary, #59636e)",
                    },
                  },
                  t("view.notMimoModel", { provider: modelProvider }),
                )
              : null,
          ),
          h(
            Card,
            { title: t("view.plan") },
            unit
              ? h(
                  "div",
                  null,
                  h(
                    Row,
                    null,
                    h(Stat, { label: t("view.usedPercent"), value: `${fmtPercent(unit.percent)}%`, accent: true }),
                    h(Stat, {
                      label: t("view.remainPercent"),
                      value: `${fmtPercent(Math.max(0, 100 - unit.percent))}%`,
                      accent: true,
                    }),
                  ),
                  h(Bar, { percent: unit.percent, danger: unit.percent > 85 }),
                  h(
                    "div",
                    {
                      style: {
                        fontSize: "12px",
                        color: "var(--dsw-alias-label-secondary, #59636e)",
                        display: "flex",
                        gap: "16px",
                        flexWrap: "wrap",
                      },
                    },
                    h("span", null, `${t("view.used")}：${fmtFull(unit.used)}`),
                    h("span", null, `${t("view.limit")}：${fmtFull(unit.limit)}`),
                    planUsage?.unit ? h("span", { style: { opacity: 0.75 } }, planUsage.unit) : null,
                    unit.label ? h("span", null, unit.label) : null,
                    summary?.plan?.planCode ? h("span", null, `${t("view.planCode")}：${summary.plan.planCode}`) : null,
                    summary?.plan?.periodEnd ? h("span", null, `${t("view.periodEnd")}：${summary.plan.periodEnd}`) : null,
                    summary?.plan?.expired
                      ? h("span", { style: { color: "var(--dsw-alias-state-error-primary, #cf222e)" } }, t("view.expired"))
                      : null,
                  ),
                )
              : h("div", { style: { color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("view.noData")),
          ),
          h(
            Card,
            { title: t("view.balance") },
            summary?.balance
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                  h(
                    Row,
                    null,
                    h(Stat, { label: summary.balance.currency, value: summary.balance.balance, accent: true }),
                    h(Stat, { label: t("view.cash"), value: summary.balance.cashBalance }),
                    h(Stat, { label: t("view.gift"), value: summary.balance.giftBalance }),
                  ),
                  // Token Plan 套餐与按量余额互不通用：套餐用户的余额恒为 0，属正常，
                  // 不说明会让用户误以为出错。
                  billingType === "token-plan"
                    ? h(
                        "div",
                        { style: { fontSize: "11px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                        t("view.balanceNote"),
                      )
                    : null,
                )
              : h("div", { style: { color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("view.noData")),
          ),
        ),

        // 会话用量 + 本地统计/预测
        h(
          "div",
          { style: { ...grid, marginTop: "14px" } },
          h(
            Card,
            { title: t("view.session") },
            session
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "10px" } },
                  h(
                    Row,
                    null,
                    h(Stat, { label: t("view.tokens"), value: fmtFull(sessTokens), accent: true }),
                    h(Stat, { label: t("view.calls"), value: fmtFull(sessCalls) }),
                    h(Stat, { label: t("view.input"), value: fmtFull(session.inputTokens) }),
                    h(Stat, { label: t("view.output"), value: fmtFull(session.outputTokens) }),
                    h(Stat, { label: t("view.cacheRead"), value: fmtFull(session.cacheReadTokens) }),
                  ),
                  // ⚠ 本会话**完全没用过 MiMo** 时：上面的数字全是 0，如果不解释，
                  //   用户会以为插件坏了 / 数据没读到。明确告知"这是正常的"，
                  //   并说明下面的套餐额度是**账号级**的、与会话无关。
                  sessionSplit?.attributed && sessionSplit.mimo.tokens === 0
                    ? h(
                        "div",
                        {
                          style: {
                            padding: "9px 11px",
                            borderRadius: "8px",
                            background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                            border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))",
                            fontSize: "12px",
                            lineHeight: 1.65,
                            color: "var(--dsw-alias-label-secondary, #59636e)",
                          },
                        },
                        h(
                          "b",
                          { style: { color: "var(--dsw-alias-label-primary, #1f2328)", fontWeight: 600 } },
                          t("view.noMimoTitle"),
                        ),
                        h("br", null),
                        t("view.noMimoBody", {
                          providers: sessOthers.map((o) => o.provider).join(" / ") || "—",
                        }),
                      )
                    : null,
                  // ⚠ 会话里混了别的渠道时**必须说清楚**：
                  //   上面的 tokens/calls 只统计 MiMo 归属部分，用户否则会以为
                  //   "少了"或"数字不对"。实测有会话 138.8M 里 64% 是 codebuddy。
                  sessForeign && sessForeign.tokens > 0
                    ? h(
                        "div",
                        {
                          style: {
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "6px",
                            alignItems: "baseline",
                            padding: "7px 10px",
                            borderRadius: "8px",
                            background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                            border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))",
                            fontSize: "11px",
                            lineHeight: 1.6,
                            color: "var(--dsw-alias-label-secondary, #59636e)",
                          },
                        },
                        h("span", null, t("view.mixed")),
                        ...sessOthers.map((o, i) =>
                          h(
                            "span",
                            {
                              key: i,
                              style: {
                                padding: "1px 7px",
                                borderRadius: "999px",
                                background: "var(--dsw-alias-bg-layer-1, #fff)",
                                border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))",
                                fontVariantNumeric: "tabular-nums",
                              },
                            },
                            `${o.provider} · ${fmtCompact(o.tokens)} · ${o.calls} ${t("view.callsUnit")}`,
                          ),
                        ),
                        h(
                          "span",
                          { style: { opacity: 0.85 } },
                          t("view.mixedTotal", { tokens: fmtCompact(sessForeign.tokens) }),
                        ),
                      )
                    : null,
                  // 无分渠道明细（老计数器 / 端点降级）：标明"未细分"，避免误读
                  sessionSplit && !sessionSplit.attributed
                    ? h(
                        "div",
                        {
                          style: {
                            fontSize: "11px",
                            lineHeight: 1.6,
                            color: "var(--dsw-alias-label-tertiary, #59636e)",
                          },
                        },
                        t("view.noBreakdown"),
                      )
                    : null,
                  session.models?.length
                    ? h(
                        "div",
                        null,
                        h(
                          "div",
                          {
                            style: {
                              fontSize: "11px",
                              color: "var(--dsw-alias-label-tertiary, #59636e)",
                              margin: "2px 0 4px",
                            },
                          },
                          t("view.breakdown"),
                        ),
                        h(
                          // 窄屏：表格外层可横向滚动，避免撑破卡片
                          "div",
                          { style: narrow ? { overflowX: "auto", margin: "0 -2px" } : null },
                          h(
                            "table",
                            {
                              style: {
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: "12px",
                                minWidth: narrow ? "340px" : undefined,
                              },
                            },
                            h(
                              "thead",
                              null,
                              h(
                                "tr",
                                null,
                                h("th", { style: thStyle }, "provider/model"),
                                h("th", { style: { ...thStyle, textAlign: "right" } }, "tokens"),
                                h("th", { style: { ...thStyle, textAlign: "right" } }, "%"),
                                h("th", { style: { ...thStyle, textAlign: "right" } }, "calls"),
                              ),
                            ),
                            h(
                              "tbody",
                              null,
                              session.models.map((m, i) => {
                                const mimo = isMiMoProviderName(m.provider);
                                const total = sessionSplit?.total || 1;
                                const pct = Math.round(((Number(m.totalTokens) || 0) / total) * 100);
                                return h(
                                  "tr",
                                  {
                                    key: i,
                                    // 非 MiMo 行整行弱化，并加"不计入"标记 ——
                                    // 免得用户以为汇总数字把这一行也算进去了
                                    style: mimo ? null : { opacity: 0.62 },
                                  },
                                  h(
                                    "td",
                                    { style: { padding: narrow ? "3px 4px" : "3px 6px", wordBreak: "break-all" } },
                                    `${m.provider}/${m.model}`,
                                    mimo
                                      ? null
                                      : h(
                                          "span",
                                          {
                                            style: {
                                              marginLeft: "6px",
                                              fontSize: "10px",
                                              padding: "0 5px",
                                              borderRadius: "999px",
                                              border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))",
                                              color: "var(--dsw-alias-label-tertiary, #59636e)",
                                              whiteSpace: "nowrap",
                                            },
                                          },
                                          t("view.notMimo"),
                                        ),
                                  ),
                                  h("td", { style: tdNum }, fmtFull(m.totalTokens)),
                                  h("td", { style: tdNum }, `${pct}%`),
                                  h("td", { style: tdNum }, fmtFull(m.calls)),
                                );
                              }),
                            ),
                          ),
                        ),
                      )
                    : null,
                  h(
                    "div",
                    { style: { borderTop: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))", paddingTop: "10px" } },
                    billingType === "payg"
                      ? h(
                          "div",
                          null,
                          h(Stat, {
                            label: chargeIsEstimated ? t("view.chargeEst") : t("view.charge"),
                            value: `¥${fmtCost(sessionCharge ?? 0)}`,
                            accent: true,
                          }),
                          price
                            ? null
                            : h(
                                "div",
                                {
                                  style: {
                                    fontSize: "11px",
                                    color: "var(--dsw-alias-label-tertiary, #59636e)",
                                    marginTop: "4px",
                                  },
                                },
                                t("view.priceMissing"),
                              ),
                          // 混合渠道时费用是按 token 占比折算的，必须标注"估算"，
                          // 否则用户会把它当成精确账目
                          chargeIsEstimated
                            ? h(
                                "div",
                                {
                                  style: {
                                    fontSize: "11px",
                                    color: "var(--dsw-alias-label-tertiary, #59636e)",
                                    marginTop: "4px",
                                    lineHeight: 1.6,
                                  },
                                },
                                t("view.chargeMixNote"),
                              )
                            : null,
                        )
                      : h(
                          "div",
                          { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                          t("view.chargeNote"),
                        ),
                  ),
                )
              : h("div", { style: { color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("view.noData")),
          ),
          h(
            Card,
            { title: t("view.stats") },
            local?.ok
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "10px" } },
                  h(
                    Row,
                    null,
                    h(Stat, { label: t("view.today"), value: fmtFull(local.todayTokens), accent: true }),
                    h(Stat, { label: t("view.month"), value: fmtFull(local.monthTokens), accent: true }),
                  ),
                  days.length
                    ? h(
                        "div",
                        {
                          style: {
                            display: "flex",
                            gap: narrow ? "2px" : "4px",
                            alignItems: "flex-end",
                            // 窄屏降低柱高，避免占满一屏
                            height: narrow ? "46px" : "60px",
                            overflowX: narrow ? "auto" : undefined,
                          },
                        },
                        days.map((d, i) =>
                          h("div", {
                            key: i,
                            title: `${d.date}：${fmtFull(d.tokens)} tokens`,
                            style: {
                              width: narrow ? "10px" : "15px",
                              flex: narrow ? "none" : undefined,
                              height: `${Math.max(4, Math.round((d.tokens / maxDay) * (narrow ? 40 : 54)))}px`,
                              background: "var(--dsw-alias-state-business-primary, #0969da)",
                              borderRadius: "3px",
                              opacity: 0.85,
                            },
                          }),
                        ),
                      )
                    : null,
                  forecast
                    ? h(
                        "div",
                        {
                          style: {
                            borderTop: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))",
                            paddingTop: "10px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px",
                          },
                        },
                        h(
                          "div",
                          {
                            style: {
                              fontSize: "11px",
                              fontWeight: 600,
                              color: "var(--dsw-alias-label-tertiary, #59636e)",
                            },
                          },
                          t("view.forecast"),
                        ),
                        h(
                          Row,
                          null,
                          h(Stat, {
                            label: forecast.sampleDays > 0 ? t("view.avgDaily", { days: forecast.sampleDays }) : t("view.todayRate"),
                            value: fmtFull(forecast.avgDaily),
                          }),
                          h(Stat, { label: t("view.projected"), value: fmtFull(forecast.projectedMonth) }),
                          forecast.projectedRemain !== null
                            ? h(Stat, {
                                label: t("view.projectedRemain"),
                                value: fmtFull(forecast.projectedRemain),
                                accent: !forecast.overBudget,
                              })
                            : null,
                        ),
                        forecast.thinSample
                          ? h(
                              "div",
                              { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                              t("view.thinSample"),
                            )
                          : null,
                      )
                    : null,
                )
              : h(
                  "div",
                  { style: { color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                  local?.error || t("view.noData"),
                ),
          ),
        ),

        // 配置区（Cookie / 套餐总量 / 胶囊位置 / 工具栏换行）
        h("div", { style: { marginTop: narrow ? "10px" : "14px" } }, h(MimoSettingsForm, { onChange: () => load(true) })),
      );
    }

    /**
     * 「MiMo 用量」页内的配置表单。
     *
     * 保存后写入 `settings.yaml` 的 `dsh-mimo-usage` 命名空间（宿主经 ctx.settings 持久化），
     * 优先级高于 patch 层 config，保存即热生效（宿主清缓存 → 胶囊下次刷新用新值）。
     *
     * Cookie 不回传明文：读取接口只返回「是否已配置 + 来源」，输入框留空表示保持不变。
     */
    function MimoSettingsForm({ onChange }) {
      const { narrow } = useViewport();
      const [cfg, setCfg] = useState(null);
      const [cookie, setCookie] = useState("");
      const [clearCookie, setClearCookie] = useState(false);
      const [planTotal, setPlanTotal] = useState("");
      const [position, setPosition] = useState("header");
      const [wrapToolbar, setWrapToolbar] = useState(true);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState(null); // {kind:'ok'|'err', text}

      useEffect(() => {
        let alive = true;
        rpc("settings")
          .then((data) => {
            if (!alive) return;
            setCfg(data);
            setPlanTotal(String(data.planTotalTokens ?? ""));
            setPosition(data.pillPosition ?? "header");
            setWrapToolbar(data.wrapToolbar !== false);
          })
          .catch((error) => {
            if (alive) setMessage({ kind: "err", text: error instanceof Error ? error.message : String(error) });
          });
        return () => {
          alive = false;
        };
      }, []);

      const save = useCallback(async () => {
        setBusy(true);
        setMessage(null);
        try {
          const payload = {
            planTotalTokens: Number(planTotal) || 0,
            pillPosition: position,
            wrapToolbar,
          };
          // Cookie 留空 = 不改；勾选清除 = 写空串
          if (clearCookie) payload.cookie = "";
          else if (cookie.trim()) payload.cookie = cookie.trim();
          await rpc("settings", undefined, "POST", payload);
          setCookie("");
          setClearCookie(false);
          const fresh = await rpc("settings").catch(() => null);
          if (fresh) {
            setCfg(fresh);
            setPlanTotal(String(fresh.planTotalTokens ?? ""));
          }
          setUiPrefs({ position, wrapToolbar });
          setMessage({ kind: "ok", text: t("cfg.saved") });
          if (typeof onChange === "function") onChange();
        } catch (error) {
          setMessage({ kind: "err", text: t("cfg.saveFailed", { error: error instanceof Error ? error.message : String(error) }) });
        } finally {
          setBusy(false);
        }
      }, [cookie, clearCookie, planTotal, position, wrapToolbar, onChange]);

      const labelStyle = {
        display: "block",
        fontSize: "11px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-secondary, #59636e)",
        marginBottom: "4px",
      };
      const inputStyle = {
        width: "100%",
        boxSizing: "border-box",
        padding: "7px 9px",
        fontSize: "12px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        color: "inherit",
        fontFamily: "inherit",
      };
      const wrapBox = narrow ? { display: "flex", flexDirection: "column", gap: "10px" } : { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" };

      return h(
        Card,
        { title: t("cfg.title") },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          h("p", { style: { margin: 0, fontSize: "11px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("cfg.hint")),

          // Cookie
          h(
            "div",
            null,
            h("label", { style: labelStyle }, t("cfg.cookie")),
            // ⚠ 用 type="text" 而不是 "password"：
            //   - Cookie 是几百字符的长串，需要能看清粘贴进去的内容（password 全是圆点）
            //   - 浏览器对 password 字段的剪贴板行为有额外限制，实测右键/粘贴不灵
            //   内容本身不会外泄：它是保存在本机 settings.yaml 的凭据，
            //   且 host 侧 /settings 只回传"是否已配置 + 来源"，从不回传明文。
            h(
              "div",
              { style: { display: "flex", gap: "6px", alignItems: "stretch" } },
              h("input", {
                type: "text",
                value: cookie,
                disabled: busy || clearCookie,
                placeholder: cfg?.cookieConfigured ? t("cfg.cookieKeep") : t("cfg.cookiePlaceholder"),
                onChange: (e) => {
                  setCookie(e.currentTarget.value);
                  setMessage(null);
                },
                onPaste: (e) => {
                  // 显式处理粘贴：部分宿主/浏览器在受控 input 上不派发 onChange，
                  // 导致粘贴后 React 的 value 不更新（表现为"粘不上"）。
                  try {
                    const text = e.clipboardData?.getData("text") ?? "";
                    if (text) {
                      e.preventDefault();
                      setCookie(text.trim());
                      setMessage(null);
                    }
                  } catch {
                    /* 交给默认行为 */
                  }
                },
                style: { ...inputStyle, flex: "1 1 auto", minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
                autoComplete: "off",
                spellCheck: false,
                "data-mimo-cookie-input": "",
              }),
              h(
                "button",
                {
                  type: "button",
                  disabled: busy || clearCookie,
                  title: t("cfg.paste"),
                  onClick: async () => {
                    // 剪贴板 API 兜底：即使浏览器不让 Ctrl+V，也能一键灌入
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) {
                        setCookie(text.trim());
                        setMessage({ kind: "ok", text: t("cfg.pasteDone") });
                        return;
                      }
                    } catch {
                      /* 无权限 / 非安全上下文 → 提示手动粘贴 */
                    }
                    setMessage({ kind: "err", text: t("cfg.pasteFail") });
                  },
                  style: {
                    flex: "none",
                    padding: "0 12px",
                    fontSize: "12px",
                    borderRadius: "8px",
                    border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
                    background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                    color: "inherit",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  },
                },
                t("cfg.paste"),
              ),
            ),
            h(
              "div",
              { style: { display: "flex", gap: "12px", alignItems: "center", marginTop: "5px", flexWrap: "wrap" } },
              h(
                "span",
                {
                  style: {
                    fontSize: "11px",
                    color: cfg?.cookieConfigured
                      ? "var(--dsw-alias-state-success-primary, #1a7f37)"
                      : "var(--dsw-alias-label-tertiary, #59636e)",
                  },
                },
                cfg?.cookieConfigured ? t("cfg.cookieConfigured", { source: cfg.cookieSource ?? "" }) : t("cfg.cookieEmpty"),
              ),
              h(
                "label",
                { style: { fontSize: "11px", display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" } },
                h("input", {
                  type: "checkbox",
                  checked: clearCookie,
                  disabled: busy,
                  onChange: (e) => setClearCookie(e.currentTarget.checked),
                }),
                t("cfg.clearCookie"),
              ),
            ),
            h("p", { style: { margin: "5px 0 0", fontSize: "11px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("cfg.cookieWhy")),
            h("p", { style: { margin: "3px 0 0", fontSize: "11px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("cfg.cookieHelp")),
          ),

          // 套餐总量 + 胶囊位置
          h(
            "div",
            { style: wrapBox },
            h(
              "div",
              null,
              h("label", { style: labelStyle }, t("cfg.planTotal")),
              h("input", {
                type: "number",
                value: planTotal,
                disabled: busy,
                min: 0,
                step: 1000000,
                onChange: (e) => {
                  setPlanTotal(e.currentTarget.value);
                  setMessage(null);
                },
                style: inputStyle,
              }),
            ),
            h(
              "div",
              null,
              h("label", { style: labelStyle }, t("cfg.pillPosition")),
              h(
                "select",
                {
                  value: position,
                  disabled: busy,
                  onChange: (e) => {
                    setPosition(e.currentTarget.value);
                    setMessage(null);
                  },
                  style: inputStyle,
                },
                h("option", { value: "header" }, t("cfg.pos.header")),
                h("option", { value: "toolbar" }, t("cfg.pos.toolbar")),
                h("option", { value: "above" }, t("cfg.pos.above")),
                h("option", { value: "hidden" }, t("cfg.pos.hidden")),
              ),
            ),
          ),

          // 工具栏换行
          h(
            "label",
            { style: { fontSize: "12px", display: "flex", gap: "6px", alignItems: "flex-start", cursor: "pointer", lineHeight: 1.5 } },
            h("input", {
              type: "checkbox",
              checked: wrapToolbar,
              disabled: busy,
              onChange: (e) => {
                setWrapToolbar(e.currentTarget.checked);
                setMessage(null);
              },
              style: { marginTop: "2px" },
            }),
            h("span", null, t("cfg.wrapToolbar")),
          ),

          // 保存
          h(
            "div",
            { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
            h(
              "button",
              {
                type: "button",
                disabled: busy || cfg?.writable === false,
                onClick: save,
                style: {
                  border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                  background: "var(--dsw-alias-state-business-primary, #0969da)",
                  color: "#fff",
                  borderRadius: "8px",
                  padding: "7px 16px",
                  cursor: busy ? "default" : "pointer",
                  fontSize: "12px",
                  opacity: busy || cfg?.writable === false ? 0.6 : 1,
                },
              },
              busy ? t("cfg.saving") : t("cfg.save"),
            ),
            message
              ? h(
                  "span",
                  {
                    style: {
                      fontSize: "11px",
                      color:
                        message.kind === "ok"
                          ? "var(--dsw-alias-state-success-primary, #1a7f37)"
                          : "var(--dsw-alias-state-error-primary, #cf222e)",
                    },
                  },
                  message.text,
                )
              : null,
          ),
          cfg && cfg.writable === false
            ? h("p", { style: { margin: 0, fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } }, t("cfg.readonly"))
            : null,
        ),
      );
    }

    /**
     * 注册本地化字典。
     *
     * `locale` 已在顶层 `exports.inject` 中声明（与官方 ui-trajectory 插件一致），
     * 因此 Cordis 保证 apply 执行时 `ctx.locale` 可读。这里仍包 try/catch，
     * 让字典问题不阻断槽位注册（`t()` 会退化为内置字典直查）。
     *
     * ⚠️ 不要用 `ctx.locale?.x` 探测服务是否可用 —— Cordis 的上下文是 Proxy，
     * 读取未 inject 的服务属性会直接抛 `cannot get property "..." without inject`；
     * 抛错发生在属性读取本身，可选链 `?.` 拦不住。唯一正确做法是声明 inject。
     */
    function bindLocale(ctx) {
      try {
        if (typeof ctx.locale.register !== "function") return;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-mimo-usage: dictionaries");
        if (typeof ctx.locale.bind === "function") boundT = ctx.locale.bind(NS);
      } catch {
        boundT = null;
      }
    }

    /**
     * 胶囊位置 → 槽位映射。
     *
     * - `header`  conversation.session.header.actions（对话 / 轨迹 标签行右侧）
     * - `toolbar` conversation.input.right（输入框工具栏右侧，模型选择器旁）
     * - `above`   conversation.composer.dock（输入框上方，独占一行，不会与工具图标挤）
     * - `hidden`  不注册胶囊
     */
    const PILL_SEATS = {
      header: { slot: "conversation.session.header.actions", order: 30, compact: false },
      toolbar: { slot: "conversation.input.right", order: 30, compact: true },
      above: { slot: "conversation.composer.dock", order: 30, compact: false },
    };

    /**
     * 输入框工具栏自动换行补丁。
     *
     * 官方 InputBar 的工具行是单行 flex，插件变多时会挤压重叠。
     * 这里注入一段样式：允许该行 wrap，并让子项保持间距。
     * 仅在用户开启 `wrapToolbar` 时生效；用唯一 id 保证幂等，插件卸载时移除。
     */
    const WRAP_STYLE_ID = "dsh-mimo-usage-toolbar-wrap";
    function applyToolbarWrap(enabled) {
      if (typeof document === "undefined") return () => {};
      const existing = document.getElementById(WRAP_STYLE_ID);
      if (!enabled) {
        existing?.remove();
        return () => {};
      }
      if (existing) return () => {};
      const style = document.createElement("style");
      style.id = WRAP_STYLE_ID;
      style.dataset.plugin = "dsh-mimo-usage";
      style.textContent = `
  /* dsh-mimo-usage：输入框工具行允许换行，避免插件工具图标互相挤占重叠。
     仅作用于会话输入区，不影响其它布局。 */
  [data-slot="conversation.composer.bar"] [class*="_tools"],
  [data-slot="conversation.composer.bar"] [class*="_actions"],
  [data-slot="conversation.input.right"],
  [data-slot="conversation.input.left"] {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  [data-slot="conversation.composer.bar"] [class*="_actions"] { min-width: 0; }
  `;
      document.head.appendChild(style);
      return () => style.remove();
    }

    function apply(ctx) {
      // 兼容旧包名/别名行残留，避免重复注册
      const entryName = ctx.fiber?.entry?.options?.name;
      // 兼容旧包名/别名行残留，避免重复注册：只有 entry 名明确**不是**本插件时才跳过。
      // ⚠️ 这里绝不能用严格相等判断 —— 宿主若用别名装载（"dsh-mimo-usage/client"、
      //    带路径后缀等），早退会让整颗插件静默消失：胶囊 + 详情页一起没了，
      //    而且一行日志都没有，表现为"装了没生效"。宁可多注册一次再靠下面的
      //    槽位去重兜底，也不要无声地整片关掉。
      if (typeof entryName === "string" && entryName.length > 0 && !/mimo-usage/i.test(entryName)) {
        probe("skipped", { entryName });
        console.warn(`[dsh-mimo-usage] 跳过装载：entry 名 "${entryName}" 不是本插件`);
        return;
      }
      probe("apply-entered", { entryName: String(entryName ?? "") });

      // 重复注册兜底（宿主可能因别名残留把同一插件载入两次）：
      // 槽位里已有本插件的 tab 就说明上一个 fiber 还活着，直接收手。
      try {
        const existing = ctx.slots.entriesOfSlot?.("conversation.view");
        if (Array.isArray(existing) && existing.some((entry) => entry?.options?.id === "mimo-usage")) {
          probe("skipped-duplicate", { entryName: String(entryName ?? "") });
          console.info("[dsh-mimo-usage] 已在槽位中注册过，跳过重复装载");
          return;
        }
      } catch {
        /* 老版本没有 entriesOfSlot 就当没有重复 */
      }

      bindLocale(ctx);

      // 1) 详情页 tab —— trajectory(10) 之后、额度(20) 之前
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          {
            name: "conversation.view",
            id: "mimo-usage",
            order: 15,
            locale: NS,
            label: () => t("view.label"),
          },
          MimoUsageView,
        ),
      );

      // 2) 胶囊：按用户配置的位置动态注册 / 迁移
      //    位置来自宿主 summary.ui.pillPosition；首帧先用默认，拉取后自动迁移。
      const disposers = new Map(); // seatKey -> dispose
      let currentSeat = null;
      const ensureSeat = (seatKey) => {
        if (currentSeat === seatKey) return;
        for (const dispose of disposers.values()) {
          try {
            dispose();
          } catch {
            /* 忽略卸载异常 */
          }
        }
        disposers.clear();
        currentSeat = seatKey;
        const seat = PILL_SEATS[seatKey];
        if (!seat) return; // hidden
        const { slot, order, compact } = seat;
        ctx.slots.inject(slot, () => {
          const dispose = ctx.slots.register(
            {
              name: slot,
              id: "mimo-usage-pill",
              order,
              locale: NS,
              label: () => t("pill.label"),
            },
            (props) => h(MimoPill, { ...props, compact }),
          );
          disposers.set(seatKey, dispose);
          return dispose;
        });
      };

      // 初始注册（默认 header），随后由偏好同步纠正
      ensureSeat(uiPrefs.position);
      const onPrefs = () => ensureSeat(uiPrefs.position);
      uiPrefs.listeners.add(onPrefs);

      // 3) 工具栏换行：随偏好开/关
      let disposeWrap = applyToolbarWrap(uiPrefs.wrapToolbar);
      const onWrap = () => {
        try {
          disposeWrap();
        } catch {
          /* 忽略 */
        }
        disposeWrap = applyToolbarWrap(uiPrefs.wrapToolbar);
      };
      uiPrefs.listeners.add(onWrap);

      // 主动拉一次偏好（不依赖胶囊是否已挂载）
      rpc("summary")
        .then((data) => {
          if (data?.ui) {
            setUiPrefs({ position: data.ui.pillPosition ?? "header", wrapToolbar: data.ui.wrapToolbar !== false });
          }
        })
        .catch(() => {
          /* 偏好拉取失败时保持默认 */
        });

      ctx.effect(
        () => () => {
          uiPrefs.listeners.delete(onPrefs);
          uiPrefs.listeners.delete(onWrap);
          try {
            disposeWrap();
          } catch {
            /* 忽略 */
          }
          for (const dispose of disposers.values()) {
            try {
              dispose();
            } catch {
              /* 忽略 */
            }
          }
          disposers.clear();
        },
        "dsh-mimo-usage: pill seats",
      );

      // 自诊断：注册完成，把结果报给宿主（/summary 的 client 字段可读）
      probe("applied", {
        entryName: String(entryName ?? ""),
        registered: ["conversation.view", PILL_SEATS[currentSeat]?.slot].filter(Boolean),
        pillPosition: String(currentSeat ?? ""),
      });
      console.info(
        `[dsh-mimo-usage] client 已装载：tab=MiMo 用量，pill=${currentSeat ?? "hidden"}`,
      );
    }

    const exports = {};
    // locale 必须与 slots 一起声明：apply 内会读取 ctx.locale，
    // 未声明的服务属性读取会被 Cordis 的上下文 Proxy 直接抛错。
    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    return exports;
  }

    window.__ModuleLoader__.load({ id: "dsh-mimo-usage", factory: makeFactory });
    probe("module-loaded");
})();
