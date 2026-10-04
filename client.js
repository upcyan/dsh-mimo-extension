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
    // dsh-mimo-extension 浏览器半：会话头部「mimo额度」胶囊 + 「MiMo 用量」详情页。
    // 工厂格式直接注册进平台模块表，仅依赖平台共享的 react（无构建步骤）。
    //
    // 挂载点：
    //   conversation.session.header.actions —— order 30，排在 trajectory(10)/jobs(20)/额度(20) 之后，
    //     即紧跟"对话 / 轨迹"标签行右侧的动作区末尾。
    //   conversation.view —— id "mimo-extension"，label "MiMo 用量"，order 15，
    //     位于 trajectory(10) 之后、额度 dashboard balance(20) 之前。
    //
    // 显示规则：
    //   Token Plan 套餐 → 标题 mimo额度 + 剩余百分比（如 "剩余 62.4%"）
    //   按量计费（payg）→ 标题 mimo额度 + 当前会话用量（如 "会话 1.2M"）
    //
    // 自诊断：浏览器里"装了没生效"服务端是看不到的，所以每个关键节点都向宿主
    // POST 一次 /dsh-mimo-extension/ping，从 /summary 的 `client.stage` 就能读出卡在哪：
    //   module-loaded（脚本已执行）→ factory（模块表已调工厂）→
    //   apply-entered（apply 开跑）→ applied（槽位注册完成）/ skipped（被守卫拦下）
    const ROUTE_PREFIX = "/dsh-mimo-extension";
    /**
     * 本插件的 **npm 包名**，同时就是组合包名（`pkg.name`）。两个官方用途：
     *   · `pluginNavigation.openBundle(PACKAGE_NAME)` —— 深链到本插件详情页；
     *   · `plugins.bundle.config` 的 `key` —— 官方 `PackageDetail` 用
     *     `ledger.bundles.has(pkg.name)` 判断"这个组合包有没有配置区"，
     *     key 不匹配就**整块不渲染**（见下方注册处说明）。
     */
    const PACKAGE_NAME = "dsh-mimo-extension";
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
    // 去尾部斜杠，避免拼出 `//dsh-mimo-extension`
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
        : typeof globalThis.fetch === "function"
          ? globalThis.fetch
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
      if (typeof globalThis.setTimeout === "function") return globalThis.setTimeout(fn, ms);
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
    const id = "dsh-mimo-extension";
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
      const mine = es.find((e) => e && e.id === "dsh-mimo-extension");
      const inBatch = ((boot && Array.isArray(boot.batches) && boot.batches) || []).some(
        (b) => Array.isArray(b.entries) && b.entries.includes("dsh-mimo-extension"),
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
    // 0.2.0 timer 客户端服务（inject 声明见 exports.inject）：动态客户端里
    // 裸 setInterval/clearInterval 被 closureTraps 拦截（TIMER_REDIRECT），
    // 组件里创建定时器一律走它。apply 时从 ctx 取，组件闭包读这里。
    let timerCtx = null;
    // 0.2 侧栏导航服务（inject "layout"）：详情页的「插件设置」跳转入口读它。
    let layoutCtx = null;
    /** 打开侧栏「插件」页 —— 0.2 起配置表单住在这里（官方 plugins.*.config 槽）。 */
    function openPluginPage() {
      // ① 先开插件页面板（保底：即使深链不可用，也落在插件页而非无处可去）
      try {
        layoutCtx?.layout?.selectPanel?.("plugins");
      } catch {
        /* ctx 是 Proxy：读未声明属性直接抛（可选链挡不住），兜底吞掉 */
      }
      // ② 再深链到本插件详情页（官方 openBundle：selectPanel + setView(kind:package)）。
      //    独立 try：深链失败不回滚已打开的面板 —— 深链只是「直达」，面板才是下限。
      //    pluginNavigation 只在插件页 fiber 存活期间 provide，读不到就停在 ①。
      try {
        layoutCtx?.pluginNavigation?.openBundle?.("dsh-mimo-extension");
      } catch {
        /* 同上：服务未就绪 / Proxy 抛 —— 静默降级到插件页根 */
      }
    }
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

    const NS = "dsh.mimoExtension";
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
            "pill.popover.usedAmount": "已用额度",
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
      "view.openSettings": "插件设置",
      "view.openSettingsHint": "打开插件页，在本插件的行上点「配置」即可编辑（Cookie / 胶囊位置 / 视觉路由等）——官方导航最深只到插件页，行配置页需在页内点开",
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
      "view.exhaustsByQuota": "预计额度耗尽",
      "view.exhaustsByExpiry": "预计到期（额度未用完）",
      "view.exhaustsValue": "{date}（约 {days} 天）",
      "view.exhaustsToday": "今天之内",
      "view.exhaustsNotePeriod": "按整个套餐周期的日均推算（官方累计 ÷ 已过 {days} 天），仅供参考。官方规则：套餐在「到期」或「额度用完」任一先到即停止服务。",
      "view.exhaustsNoteRecent": "本地记录不足一个完整周期，改用近 {days} 日的速度推算，仅供参考。官方规则：套餐在「到期」或「额度用完」任一先到即停止服务。",
      "view.charge": "收费估算",
      "view.chargeNote": "Token Plan 套餐内调用不额外收费，只消耗套餐配额。",
      "view.chargeEst": "会话费用（估算）",
      "view.chargeMixNote": "本会话混用了非 MiMo 渠道，而分渠道明细只有总量、没有输入/输出拆分，故按 token 占比折算，仅供参考。",
      "view.mixed": "本会话还用过非 MiMo 渠道（不计入上面的汇总）：",
      "view.mixedTotal": "合计 {tokens} tokens",
      "view.callsUnit": "次",
      "view.noBreakdown": "该会话没有分渠道明细（老计数器或统计降级），上面的数字按整体统计，可能包含非 MiMo 渠道。",
      "view.notMimo": "不计入 MiMo",
      "view.modelSelected": "（当前选中）",
      "view.noMimoTitle": "本会话尚未使用 MiMo",
      "view.noMimoBody": "会话用量为 0 是正常的：本会话只用了 {providers}。「套餐额度」是账号级的，与本会话无关。",
      "view.notMimoModel": "当前模型属于 {provider}，不是 MiMo。套餐额度是 MiMo 账号级的，与本页其它数据一样，不随模型变化。",
      "view.hiddenNotMimo": "当前模型不是 MiMo，已按设置隐藏本页内容。想一直显示，在页面底部「MiMo 额度配置」里关掉「非 MiMo 模型时隐藏详情页」。",
      "view.noData": "暂无数据",
      "view.priceMissing": "未配置单价，按 0 估算",
      "view.src.official": "官方",
      "view.src.local": "本地",
      "view.updated": "更新于",
      // —— 设置表单 ——
      "cfg.title": "MiMo 额度配置",
      "cfg.hint": "Cookie 用于读取小米官方套餐剩余；留空则用本地估算。Cookie 只保存在本机 settings.yaml，不会回传到浏览器。",
      "cfg.cookie": "MiMo 控制台 Cookie",
      "cfg.cookieVault": "安全保存到凭据库",
      "cfg.cookieVaultHint": "写入 DSH 凭据库（.credentials.yaml，权限 0600），明文不进 settings.yaml",
      "cfg.cookieVaultSaved": "已安全保存到凭据库（引用名 {ref}）",
      "cfg.cookieVaultFailed": "凭据库保存失败：{error}",
      "cfg.cookieVaultUnavailable": "本部署未挂载凭据服务，请改用上面的输入框保存",
      "cfg.cookieInvalid": "Cookie 校验未通过，未保存：{error}",
      "cfg.cookieOpenConsole": "打开官方控制台",
      "cfg.cookieRiskTitle": "安全提示：请先阅读",
      "cfg.cookieRiskBody": "• 这个 Cookie 等同于你的小米账号访问权（可读 MiMo 账单与套餐），请勿分享。\n• 只保存在本机，且只发往 platform.xiaomimimo.com。\n• 优先存进凭据库（权限 0600）；不勾选时才会落到 settings.yaml 明文。\n• 小米改密码/退出登录会使其失效，届时重新获取即可。\n• 随时可在本页用「清除已保存的 Cookie」撤销。",
      "cfg.cookieRiskConfirm": "我已了解风险，继续保存",
      "cfg.cookieRiskCancel": "取消",
      "cfg.cookieRiskShow": "为什么需要它 · 风险说明",
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
      "cfg.hideViewWhenNotMiMo": "非 MiMo 模型时隐藏「MiMo 用量」详情页",
      "cfg.hideViewWhenNotMiMoHint": "默认关闭：无论当前模型是什么都显示该页。开启后，用别的模型时这一页只提示、不显示用量数据。",
      "cfg.wrapToolbar": "允许输入框工具栏自动换行（防止工具图标挤占重叠）",
      "cfg.visionRouting": "启用 MiMo 视觉路由（图像输入）",
      "cfg.visionRoutingHint": "给小米渠道的 MiMo 模型声明图像输入：平台内置渠道（xiaomi / xiaomi-token-plan-*）与自建渠道（地址为 xiaomimimo.com 的）都覆盖，含 mimo-v2.5 与 v2.6 系列。开启后图片即可发给这些模型；纯文本模型不受影响。",
      "cfg.visionTextModels": "同时为纯文本模型提供视觉能力",
      "cfg.visionTextModelsHint": "给平台标为纯文本的模型（内置与自建小米渠道的 mimo-v2.5-pro 等）也声明图像输入。⚠ 这属于越权声明：上游可能拒绝，或静默丢弃图片（你未必收到报错）。仅在确认这些模型实际能读图时开启。",
      "cfg.visionOn": "已开启视觉路由：{list}",
      "cfg.visionOff": "已关闭视觉路由：{list}",
      "cfg.visionFailed": "视觉路由设置失败：{error}",
      "cfg.save": "保存",
      "cfg.saving": "保存中…",
      "cfg.saved": "已保存",
      "cfg.saveFailed": "保存失败：{error}",
      "cfg.readonly": "当前环境设置不可写（settings 服务未装配）",
      "cfg.cookieHelp": "获取步骤：登录 platform.xiaomimimo.com/console/balance → DevTools → Network → 任一 /api/v1 请求 → 复制完整 Cookie 请求头（需含 api-platform_serviceToken 与 userId）。",
      "view.authExpiredTitle": "MiMo 登录已失效",
      "view.authExpiredHint": "官方接口返回 401。本页数字是本地估算，不是你的真实套餐额度。重新登录小米账号并更新 Cookie 即可恢复。",
      "view.authExpiredAction": "去更新 Cookie →",
      "view.localGeneric": "本地估算（未登录或登录已失效）",
      "cfg.verify": "验证",
      "cfg.verifying": "验证中…",
      "cfg.verifyEmpty": "请先粘贴 Cookie",
      "cfg.verifyOk": "Cookie 可用 ✅",
      "cfg.verifyPlan": "套餐 {code}，有效期至 {end}；本月已用 {used} / {limit} {unit}",
      "cfg.verifyExpired": "Cookie 已失效（官方返回 401），请重新登录获取",
      "cfg.verifyFail": "验证失败",
      "cfg.guideShow": "怎么获取 Cookie？",
      "cfg.guideHide": "收起说明",
      "cfg.guideTitle": "获取 Cookie 的步骤",
      "cfg.guideStep1": "1. 打开 platform.xiaomimimo.com/console/balance 并登录小米账号",
      "cfg.guideStep2": "2. 按 F12 打开开发者工具，切到 Network 标签",
      "cfg.guideStep3": "3. 刷新页面，点任意一个 /api/v1 请求，在 Headers 里找到 Cookie 请求头",
      "cfg.guideStep4": "4. 复制完整的一整段，粘到上面的输入框，点「验证」确认可用后再保存",
      "cfg.guideWhyManual": "为什么不能一键登录：小米只提供网页登录，没有开放授权接口，插件拿不到登录回调；额度接口也只认 Cookie，不认 API Key。",
      "cfg.guideOpenConsole": "打开 MiMo 控制台 →",
      "cfg.paste": "粘贴",
      "cfg.pasteDone": "已从剪贴板填入（记得点保存）",
      "cfg.pasteFail": "读不到剪贴板，请手动按 Ctrl+V，或右键粘贴",
      "cfg.cookieWhy": "这个 Cookie 用来读套餐（Token Plan）额度：tokenPlan/detail 与 tokenPlan/usage 两个接口都必须带它；按量计费的余额（balance）也是同一个凭据。",
    
      "view.staleSource": "官方数据（缓存，截至 {time}）",
            "view.authExpiredStale": "官方接口返回 401，登录已失效。下面显示的是上次成功获取的缓存数据（截至 {time}），不是实时额度。重新登录小米账号并更新 Cookie 即可恢复。",
            "cfg.visionAllMimo": "为所有 MiMo 渠道的模型声明视觉能力",
            "cfg.visionAllMimoHint": "判定为 MiMo 渠道（按地址，未知时按名称）上的全部模型都声明图像输入——含别名模型与未来新模型。⚠ 按名称判定不确信：非小米后端的同名模型也会被声明。主开关关闭时本项无效。",
            "view.frameMonth": "本月",
      "view.framePeriod": "本周期",
      "view.usedPercentFrame": "{frame}已用",
      "view.remainPercentFrame": "{frame}剩余",
      "view.quotaYearlyLabel": "套餐额度（年度）",
      "view.yearlyNote": "年度套餐：额度在整个周期内共用，没有月度上限。",
      "pill.popover.usedFrame": "{frame}已用",
    
    
      "view.legendCache": "缓存命中输入",
      "view.legendMiss": "未命中输入",
      "view.legendOut": "输出",
      "view.legendHint": "点击高亮该分段（再点取消）",
      "view.modeCompareTitle": "MiMo 模式省不省 Credits",
      "view.modeCompareLine": "开启前 {bd} 天日均 {before} → 开启后 {ad} 天日均 {after} Credits（{dir}{pct}）",
      "view.modeCompareNote": "按每日 Credits 估算对比；任务难度、缓存命中率都会影响，趋势仅供参考。",
      "view.modeCompareNoData": "开启/关闭「MiMo 模式」后会在这里对比切换前后的日均 Credits 消耗。",
      "view.todayCredits": "今日 (Credits·估)",
      "view.monthCredits": "本月 (Credits·估)",
    
      "view.legendOffPeak": "（北京时间 00:00–08:00 按 8 折计）",
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
            "pill.popover.usedAmount": "Used quota",
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
      "view.openSettings": "Plugin settings",
      "view.openSettingsHint": "Opens the plugin page; click Configure on this plugin's row to edit it (cookie / pill position / vision routing, …). Official navigation goes no deeper than the bundle page.",
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
      "view.exhaustsByQuota": "Quota runs out",
      "view.exhaustsByExpiry": "Expires first",
      "view.exhaustsValue": "{date} (~{days}d)",
      "view.exhaustsToday": "Today",
      "view.exhaustsNotePeriod": "Extrapolated from the whole plan period (provider total over {days} days elapsed); indicative only. Per the provider, service stops at whichever comes first: expiry or quota exhaustion.",
      "view.exhaustsNoteRecent": "Not enough local history for a full period, so this uses the pace of the last {days} days; indicative only. Per the provider, service stops at whichever comes first: expiry or quota exhaustion.",
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
      "view.noMimoBody": "Zero session usage is expected here: this session only used {providers}. Plan quota is account-level and unrelated to the session.",
      "view.notMimoModel": "The current model belongs to {provider}, not MiMo. The plan quota is MiMo account-level and, like the rest of this page, does not follow the model.",
      "view.hiddenNotMimo": "The current model is not MiMo, so this page is hidden per your setting. To always show it, turn off \"Hide the MiMo usage tab when the model is not MiMo\" under MiMo quota settings at the bottom of the page.",
      "view.noData": "No data",
      "view.priceMissing": "No price configured; estimated at 0",
      "view.src.official": "official",
      "view.src.local": "local",
      "view.updated": "Updated",
      // —— settings form ——
      "cfg.title": "MiMo quota settings",
      "cfg.hint": "The cookie reads your Xiaomi official plan quota; leave it empty to use the local estimate. It is stored only in this machine's settings.yaml and is never sent back to the browser.",
      "cfg.cookie": "MiMo console cookie",
      "cfg.cookieVault": "Save to credential vault",
      "cfg.cookieVaultHint": "Stores it in the DSH credential vault (.credentials.yaml, mode 0600) instead of plaintext settings.yaml",
      "cfg.cookieVaultSaved": "Saved to the credential vault (ref {ref})",
      "cfg.cookieVaultFailed": "Credential vault save failed: {error}",
      "cfg.cookieVaultUnavailable": "This deployment mounts no credential provider; use the input above instead",
      "cfg.cookieInvalid": "Cookie validation failed, not saved: {error}",
      "cfg.cookieOpenConsole": "Open official console",
      "cfg.cookieRiskTitle": "Security notice — please read",
      "cfg.cookieRiskBody": "• This cookie grants access to your Xiaomi account (MiMo billing and plan data); never share it.\n• It is stored on this machine only and sent solely to platform.xiaomimimo.com.\n• Prefer the credential vault (mode 0600); only if you skip it does the value land in plaintext settings.yaml.\n• Changing your Xiaomi password or signing out invalidates it; just fetch it again.\n• You can revoke it anytime with Clear saved cookie on this page.",
      "cfg.cookieRiskConfirm": "I understand the risk, save it",
      "cfg.cookieRiskCancel": "Cancel",
      "cfg.cookieRiskShow": "Why it is needed · risks",
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
      "cfg.hideViewWhenNotMiMo": "Hide the MiMo usage tab when the model is not MiMo",
      "cfg.hideViewWhenNotMiMoHint": "Off by default: the tab is always available. When on, using another model leaves the tab showing a notice instead of usage data.",
      "cfg.wrapToolbar": "Let the composer toolbar wrap (prevents tool icons from overlapping)",
      "cfg.visionRouting": "Enable MiMo vision routing (image input)",
      "cfg.visionRoutingHint": "Declares image input for MiMo models on Xiaomi channels — both the built-in providers (xiaomi / xiaomi-token-plan-*) and self-built ones whose address points at xiaomimimo.com — covering mimo-v2.5 and the v2.6 series. Text-only models are left alone. Text-only models like mimo-v2.5-pro are left untouched.",
      "cfg.visionTextModels": "Also give text-only models vision",
      "cfg.visionTextModelsHint": "Declares image input for text-only models (mimo-v2.5-pro and similar) on both built-in and self-built Xiaomi channels. Warning: this overstates their capability, so the upstream may refuse the image or drop it silently. Enable it only if you know these models can read images.",
      "cfg.visionOn": "Vision routing enabled: {list}",
      "cfg.visionOff": "Vision routing disabled: {list}",
      "cfg.visionFailed": "Vision routing failed: {error}",
      "cfg.save": "Save",
      "cfg.saving": "Saving…",
      "cfg.saved": "Saved",
      "cfg.saveFailed": "Save failed: {error}",
      "cfg.readonly": "Settings are read-only here (the settings service is not mounted).",
      "cfg.cookieHelp": "How to get it: sign in at platform.xiaomimimo.com/console/balance → DevTools → Network → any /api/v1 request → copy the full Cookie request header (must include api-platform_serviceToken and userId).",
      "view.authExpiredTitle": "MiMo sign-in has expired",
      "view.authExpiredHint": "The official API returned 401. The figures on this page are local estimates, not your actual plan quota. Sign in again and update the cookie to restore them.",
      "view.authExpiredAction": "Update cookie →",
      "view.localGeneric": "Local estimate (not signed in, or sign-in expired)",
      "cfg.verify": "Verify",
      "cfg.verifying": "Verifying…",
      "cfg.verifyEmpty": "Paste a cookie first",
      "cfg.verifyOk": "Cookie works ✅",
      "cfg.verifyPlan": "Plan {code}, valid until {end}; used this month {used} / {limit} {unit}",
      "cfg.verifyExpired": "Cookie has expired (the API returned 401) — sign in again to get a new one",
      "cfg.verifyFail": "Verification failed",
      "cfg.guideShow": "How do I get the cookie?",
      "cfg.guideHide": "Hide instructions",
      "cfg.guideTitle": "Getting the cookie",
      "cfg.guideStep1": "1. Open platform.xiaomimimo.com/console/balance and sign in with your Xiaomi account",
      "cfg.guideStep2": "2. Press F12 for developer tools, then open the Network tab",
      "cfg.guideStep3": "3. Reload the page, click any /api/v1 request, and find the Cookie request header under Headers",
      "cfg.guideStep4": "4. Copy the whole value into the field above, press Verify, and save once it passes",
      "cfg.guideWhyManual": "Why there is no one-click sign-in: Xiaomi offers only a web login, with no authorization endpoint for the plugin to call back to, and the quota API accepts only the cookie, not an API key.",
      "cfg.guideOpenConsole": "Open the MiMo console →",
      "cfg.paste": "Paste",
      "cfg.pasteDone": "Filled from clipboard (remember to Save)",
      "cfg.pasteFail": "Clipboard unavailable — press Ctrl+V manually or right-click paste",
      "cfg.cookieWhy": "This cookie reads your plan (Token Plan) quota: both tokenPlan/detail and tokenPlan/usage require it. The pay-as-you-go balance endpoint uses the same credential.",
    
      "view.staleSource": "Provider data (cached, as of {time})",
            "view.authExpiredStale": "The official API returned 401 — your sign-in has expired. The figures below are cached from the last successful fetch (as of {time}), not live quota. Sign in again and update the cookie to restore live data.",
            "cfg.visionAllMimo": "Declare vision for all models on MiMo channels",
            "cfg.visionAllMimoHint": "Declares image input for every model on a channel identified as MiMo (by address, falling back to name) — including aliased models and future ones. Warning: name-based matching is not certain; a same-named model on a non-Xiaomi backend would also be declared. No effect while the main switch is off.",
            "view.frameMonth": "this month",
      "view.framePeriod": "this period",
      "view.usedPercentFrame": "Used ({frame})",
      "view.remainPercentFrame": "Left ({frame})",
      "view.quotaYearlyLabel": "Plan quota (yearly)",
      "view.yearlyNote": "Yearly plan: the quota is shared across the whole period — there is no monthly cap.",
      "pill.popover.usedFrame": "Used ({frame})",
    
    
      "view.legendCache": "cached input",
      "view.legendMiss": "uncached input",
      "view.legendOut": "output",
      "view.legendHint": "Click to highlight this segment (click again to clear)",
      "view.modeCompareTitle": "Does MiMo mode save Credits?",
      "view.modeCompareLine": "Before: {before}/day over {bd}d → After: {after}/day over {ad}d ({dir}{pct})",
      "view.modeCompareNote": "Compared from daily Credit estimates; task mix and cache-hit rate both affect it — read as a trend, not a bill.",
      "view.modeCompareNoData": "After you toggle \"MiMo mode\", the before/after daily Credit comparison will appear here.",
      "view.todayCredits": "Today (Credits·est)",
      "view.monthCredits": "This month (Credits·est)",
    
      "view.legendOffPeak": "(Beijing 00:00–08:00 counted at 0.8×)",
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
    /**
     * 把官方接口的原始错误串压成一句能看的短句。
     *
     * 上游 401 的 body 是 `{"code":401,"loginUrl":"https://account.xiaomi.com/..."}`，
     * 直接铺到界面上就是几百字符加一条长 URL。这里只保留最前面的形态描述
     * （`HTTP 401` / 超时 之类），细节留给控制台。
     */
    /** 缓存标注用的时间：到分钟（"几天前"不够准，缓存龄是关键信息）。 */
    function fmtTime(ts) {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "—";
      const p = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function shortError(raw) {
      const text = typeof raw === "string" ? raw : raw ? String(raw) : "";
      if (!text) return "未知原因";
      const head = text.split(/[;；]/)[0].trim();
      return head.length > 60 ? `${head.slice(0, 60)}…` : head;
    }

    const fmtFull = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "0");
    const fmtPercent = (p) => (!Number.isFinite(p) ? "0" : p >= 10 ? p.toFixed(1) : p.toFixed(2));
    function fmtCost(c) {
      if (!Number.isFinite(c) || c <= 0) return "0.00";
      if (c < 0.01) return c.toFixed(4);
      if (c < 1) return c.toFixed(3);
      return c.toFixed(2);
    }

    /**
     * 判断一个 provider 名是否属于小米 MiMo 通道（**与 host 的 `isMiMoProvider` 同规则**）。
     *
     * ⚠ 不能只匹配 `/mimo/i`：平台内置的 provider 叫
     * `xiaomi-token-plan-cn` / `xiaomi-token-plan-sgp` / `xiaomi-token-plan-ams`
     * （套餐）与 `xiaomi`（按量）—— **都不含 `mimo`**，但它们供的模型是
     * `mimo-v2.5` / `mimo-v2.5-pro`。旧规则会把这些判成"非 MiMo"。
     *
     * 注意：这是**名字线索**。权威判据是 host 下发的 `summary.isMiMo`
     * （它按解析后的 API 地址判定，见 host 的 `resolveMiMoChannel`）——
     * 本函数只在拿不到 host 结论时兜底。
     */
    const isMiMoProviderName = (p) =>
      typeof p === "string" && (/mimo/i.test(p) || /^xiaomi(-|$)/i.test(p));

    /**
     * 判断一组 provider/model 是否属于 MiMo（**会话明细专用**）。
     * `/session` 的 `models[]` 只有 provider + model、**没有 baseURL**，
     * 所以这里只能按名字匹配 —— 因此**额外看 model 名**（`mimo-v2.5`）。
     */
    const isMiMoEntry = (provider, model) =>
      isMiMoProviderName(provider) || (typeof model === "string" && /mimo/i.test(model));

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
      const mimoModels = models.filter((m) => isMiMoEntry(m.provider, m.model));
      const otherModels = models.filter((m) => !isMiMoEntry(m.provider, m.model));
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
      if (isMiMoProviderName(selectedProvider)) {
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
          direct("mimo-extension", "");
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
    const uiPrefs = {
      position: "header",
      wrapToolbar: true,
      // 非 MiMo 模型时隐藏详情页（用户可选，默认关闭）
      hideViewWhenNotMiMo: false,
      loaded: false,
      listeners: new Set(),
    };
    function setUiPrefs(next) {
      const changed =
        uiPrefs.position !== next.position ||
        uiPrefs.wrapToolbar !== next.wrapToolbar ||
        uiPrefs.hideViewWhenNotMiMo !== next.hideViewWhenNotMiMo;
      uiPrefs.position = next.position;
      uiPrefs.wrapToolbar = next.wrapToolbar;
      if (typeof next.hideViewWhenNotMiMo === "boolean") uiPrefs.hideViewWhenNotMiMo = next.hideViewWhenNotMiMo;
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
      return {
        position: uiPrefs.position,
        wrapToolbar: uiPrefs.wrapToolbar,
        hideViewWhenNotMiMo: uiPrefs.hideViewWhenNotMiMo,
        loaded: uiPrefs.loaded,
      };
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
          if (data?.ui)
            setUiPrefs({
              position: data.ui.pillPosition ?? "header",
              wrapToolbar: data.ui.wrapToolbar !== false,
              hideViewWhenNotMiMo: data.ui.hideViewWhenNotMiMo === true,
            });
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
        // 0.2.0：裸 setInterval/clearInterval 会被 closureTraps 当场抛错
        // （TIMER_REDIRECT）→ 整个胶囊消失。官方做法：inject 声明 timer，
        // ctx.interval(cb, ms) 直接返回 disposer，cleanup 里调用。
        // globalThis 兜底只服务离线测试环境（真浏览器的属性访问不被 trap）。
        const stopPolling =
          typeof timerCtx?.interval === "function"
            ? timerCtx.interval(refresh, 60_000)
            : (() => {
                const t = globalThis.setInterval(refresh, 60_000);
                return () => globalThis.clearInterval(t);
              })();
        const onVisible = () => {
          if (!document.hidden) refresh();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          stopPolling();
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
      const selectedModel = selected?.model ?? summary?.model ?? undefined;

      // ── 「是否 MiMo」判定：**优先用 host 的地址级结论** ──────────────
      //
      // host 侧 `resolveMiMoChannel()` 是按**解析后的 API 地址**判的
      // （`xiaomimimo.com` 域名才算），比名字可靠 —— 名字会两头骗人：
      //   · 平台内置 provider `xiaomi-token-plan-cn` 不含 `mimo`（旧规则漏判）
      //   · 自建网关可以叫 `mimo-xxx` 却指向别家（旧规则误判）
      // 所以：host 结论与当前选中 provider **一致**时直接采信；
      // 否则（刚切模型、summary 还没跟上）退回名字规则兜底。
      const providerIsMiMo = (() => {
        const hostSays = typeof summary?.isMiMo === "boolean" ? summary.isMiMo : undefined;
        const hostProvider = summary?.provider;
        // host 结论只对它自己那个 provider 有效
        if (hostSays !== undefined && hostProvider && hostProvider === selectedProvider) {
          return hostSays;
        }
        // 兜底：名字线索（provider 名或 model 名命中）
        if (selectedProvider === undefined && !selectedModel) return true; // 读不到 → 保守显示
        return isMiMoEntry(selectedProvider, selectedModel);
      })();
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
      // 套餐额度的计量单位，官方 `tokenPlan/usage` 回 "Credits"。
      // ⚠ 不是 tokens，也不是人民币 —— 别自己编单位，取回来直接用。
      const planUsageUnit = summary?.planUsage?.unit ?? "";
      const remainPercent = unit ? Math.max(0, 100 - unit.percent) : null;
      const isPlan = billingType === "token-plan";
      // 周期口径（与详情页一致）：年付无月度子限额，额度整期共用
      const isYearlyPlan = /year|annual/i.test(String(summary?.plan?.planCode ?? ""));
      const quotaFrame = isYearlyPlan ? t("view.framePeriod") : t("view.frameMonth");

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
            isPlan && unit
              ? line(t("pill.popover.usedFrame", { frame: quotaFrame }), `${fmtPercent(unit.percent)}%`)
              : null,
            // 已用额度的**绝对值**（Credits）。上面那行是百分比，这行是实际消耗量 ——
            // 两者一起看才知道"用了多少 / 占多少"。
            // 单位取自 `planUsage.unit`（官方回的 "Credits"），不硬编码。
            isPlan && unit
              ? line(
                  t("pill.popover.usedAmount"),
                  `${fmtFull(unit.used ?? 0)}${planUsageUnit ? ` ${planUsageUnit}` : ""}`,
                )
              : null,
            isPlan && unit
              ? line(
                  t("pill.popover.total"),
                  `${fmtFull(unit.limit ?? 0)}${planUsageUnit ? ` ${planUsageUnit}` : ""}`,
                )
              : null,
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

    /**
     * 详情页的字号阶梯 —— **按语义角色定字号，不要随手写 px**。
     *
     * 之前 26 处 `fontSize` 散成 8 种取值，其中 `11px` 一个人扛了 6 种角色
     * （Stat 标签、脚注、表格单元格、图例…），于是同级内容字号不同、
     * 不同级内容字号相同，用户看不出层级。
     *
     * 平台没有导出字号 token（`dsh-web-frontend` 里没有 `--dsw-*font*` 变量，
     * 官方视图也是直接写 px：chat 用 14/12/11，trajectory 用 12/10/18），
     * 所以这里自建一套，取值贴近官方视图的习惯。
     *
     * ⚠ 新增文案时**从这里面挑**，别再写字面量。想加档位先问：
     *    它是标题、正文、标签还是脚注？归到已有档位里去。
     */
    const FS = {
      /** 卡片标题（Card 的 H3）。 */
      title: "14px",
      /** 页面主标题。 */
      pageTitle: "17px",
      /** KPI 数值（Stat 的 value）—— 全页最大，锚定视觉重心。 */
      kpi: "17px",
      /** 紧凑数字强调：弹窗里的数值行、卡片内的百分比。比正文大半档。 */
      kpiSm: "13px",
      /** 正文：表格单元格、列表项、弹窗行。 */
      body: "12px",
      /** 字段标签（Stat 的 label）、按钮、次级说明。 */
      label: "11px",
      /** 脚注 / 免责说明：最次级，只用于"仅供参考"这类附注。 */
      note: "10.5px",
    };

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
            // ── 让卡片内容能"撑满"卡片高度 ──────────────────────────────
            // 网格行高由**同行最高的卡片**决定（`align-items` 默认 stretch），
            // 所以「用量统计（本地）」总是被旁边更高的卡片拉高。
            // 卡片自己必须是 flex 纵向容器，子块才能用 flex:1 认领剩余空间；
            // 否则内容按自然高度堆在上面，底部留一大片空白。
            display: "flex",
            flexDirection: "column",
          },
        },
        title
          ? h(
              "h3",
              {
                style: {
                  margin: "0 0 10px",
                  fontSize: FS.title,
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

    /**
     * 一个"标签 + 数值"的小块。
     *
     * `unit` 单独一个参数而不是拼进 `value`：详情页同时存在三种口径
     * （tokens / Credits / 元），而 `Credits` 与 `tokens` **不可通约**。
     * 单位必须每个数字都标出来 —— 但排在数字后面、字号更小、颜色更淡，
     * 这样一眼能分清哪些能直接比大小。
     */
    function Stat({ label, value, unit, accent, hint }) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "96px" } },
        h("span", { style: { fontSize: FS.label, color: "var(--dsw-alias-label-tertiary, #59636e)" } }, label),
        h(
          "span",
          { style: { display: "flex", alignItems: "baseline", gap: "4px", flexWrap: "wrap" } },
          h(
            "span",
            {
              style: {
                fontSize: FS.kpi,
                fontWeight: 650,
                fontVariantNumeric: "tabular-nums",
                color: accent
                  ? "var(--dsw-alias-state-business-primary, #0969da)"
                  : "var(--dsw-alias-label-primary, #1f2328)",
              },
            },
            value,
          ),
          unit
            ? h(
                "span",
                {
                  style: {
                    fontSize: FS.label,
                    fontWeight: 500,
                    color: "var(--dsw-alias-label-tertiary, #59636e)",
                  },
                },
                unit,
              )
            : null,
        ),
        // 可选补充说明（如"估算"）—— 比塞进 label 更清楚，也不挤占标签行
        hint
          ? h("span", { style: { fontSize: FS.note, color: "var(--dsw-alias-label-tertiary, #59636e)" } }, hint)
          : null,
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

      // 登录是否失效（来自 /summary 的 authExpired）；用于显示「重新登录」提示条

      const [authExpired, setAuthExpired] = useState(false);
      // 数据是否为缓存快照（Cookie 过期/接口失败时，宿主用上次成功结果兜底）
      const [stale, setStale] = useState(false);
      const [staleAt, setStaleAt] = useState(null);
      // 每日 Credits 历史 + 模式时间线（宿主落盘文件，含前后日均对比）
      const [creditsCompare, setCreditsCompare] = useState(null);
      // 图例点选：高亮堆叠柱里的某一段（"变大一圈"），再点同项取消。
      // 纯展示态，不影响任何请求；放在其它 useState 之后、任何提前 return 之前。
      const [legendPick, setLegendPick] = useState(null);
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
            if (epoch === epochRef.current) {
              setSummary(data);
              setAuthExpired(data?.authExpired === true);
              setStale(data?.stale === true);
              setStaleAt(data?.staleAt ?? null);
              setCreditsCompare(data?.creditsStats ?? null);
            }
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
      // ── 套餐周期口径 ──────────────────────────────────────────────
      // 用户反馈（09-28）：年付套餐显示「本月套餐额度」是误导。
      // 实测与文档都证实**个人版没有月度子限额**：
      //   · 官方接口里 monthUsage.limit == usage.limit == 年度总额（492 亿）
      //     —— 若有月度子限额，前者应是月度值；
      //   · 文档只对**团队版**提"月度额度耗尽/等待额度重置"，个人版只说
      //     "到期或全部 Credits 用完任一先到即停"。
      // 所以年付时额度口径是「本周期」；只有月付才是「本月」。
      const planCodeStr = String(summary?.plan?.planCode ?? "");
      const isYearlyPlan = /year|annual/i.test(planCodeStr);
      const quotaFrame = isYearlyPlan ? t("view.framePeriod") : t("view.frameMonth");
      // 套餐额度的计量单位（官方回 "Credits"）。
      // 🔴 必须在**这个函数里也定义一次** —— 它与 MimoPill 里的同名常量分属
      // 两个函数作用域，不共享。我上一轮只加在 MimoPill 里，却在详情页也用了它
      // （下面的 used/limit 两行），结果详情页一渲染就抛
      // `planUsageUnit is not defined` → **整页空白**。
      // ⚠ 静态检查查不出"引用了别的作用域变量"这类错误，只有真跑渲染才会暴露。
      const planUsageUnit = planUsage?.unit ?? "";
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
        const limit = unit?.limit ?? 0;
        const usedUnits = unit?.used ?? 0;

        // ── 单位口径（关键，别混用）────────────────────────────────────
        // `limit` / `used` 的单位是**官方口径**：
        //   · 官方模式 → "Credits"（按模型倍率折算：缓存 2 / 未命中 100 / 输出 200）
        //   · 本地估算模式 → "tokens"（issued == monthTokens）
        // 而 `avgDaily` / `monthTokens` 是**原始 token 数**，两者**不能直接相减**。
        // 实测（09-28，official=true）：
        //   used 7,654,674,811 Credits vs monthTokens 1,997,917,904 tokens → 比值 3.83
        // 早期版本直接 `limit - projectedMonth`（Credits − tokens）→ 偏差 49 亿（约 12%）。
        //
        // ✅ 换算率 = used / monthTokens，即"每 token 折多少额度单位"。
        //    本地模式下 used 就等于 monthTokens → 恒为 1，**两种模式自动兼容**。
        const unitsPerToken =
          local.monthTokens > 0 && usedUnits > 0 ? usedUnits / local.monthTokens : 0;
        const projectedMonth = local.monthTokens + avgDaily * remainingDays;

        // ── 全周期日均（用户反馈：不该只看最近几天）────────────────────
        // 只看近 3~7 天会失真：实测本机 09-25 是 56M、09-27 涨到 929M，
        // 换个窗口结论就能差好几倍。
        //
        // ✅ 权威口径是**官方累计 ÷ 已过天数**：
        //    `plan_total_token`（extra[0]）是**整个套餐周期**的累计用量
        //    （`month_total_token` 每月归零，不能用来算全周期）。
        //    周期起始 = 到期日往前推一个订阅周期（planCode 里的 `year`/`month`）。
        //
        // ⚠ 拿不到周期信息时退化为"本地已有天数的日均"，并沿用 thinSample 标注。
        const planItems = Array.isArray(planUsage?.extra) ? planUsage.extra : [];
        const periodUsed = Number(planItems.find((x) => x?.name === "plan_total_token")?.used) || 0;
        const periodEndRaw = summary?.plan?.periodEnd ? new Date(String(summary.plan.periodEnd).replace(" ", "T")) : null;
        const periodEndValid = periodEndRaw && !Number.isNaN(periodEndRaw.getTime());
        // 订阅周期长度：planCode 形如 "lite:year" / "lite:month"
        const code = String(summary?.plan?.planCode ?? "");
        const periodDays = /year|annual|:y\b/i.test(code) ? 365 : /month|:m\b/i.test(code) ? 30 : null;
        const periodStart = periodEndValid && periodDays ? new Date(periodEndRaw.getTime() - periodDays * 86400000) : null;
        const elapsedDays = periodStart ? Math.max(1, Math.floor((now.getTime() - periodStart.getTime()) / 86400000)) : null;
        // 全周期日均（额度单位）：官方累计 ÷ 已过天数
        const periodDailyUnits = periodUsed > 0 && elapsedDays ? periodUsed / elapsedDays : null;

        // ── 额度耗尽预测 ───────────────────────────────────────────────
        // 官方规则（mimo.mi.com 文档）："套餐在**到期**或**全部 Credits 用完**
        // 任一条件满足时，即停止服务"。所以"还能用多久"= min(额度耗尽, 套餐到期)。
        let daysToExhaust = null;
        let exhaustDate = null;
        let exhausted = null; // 'units' | 'expiry' | null —— 谁先到
        if (limit > 0 && usedUnits > 0 && (unitsPerToken > 0 || periodDailyUnits > 0)) {
          // 🔴 优先用**全周期日均**（官方累计 ÷ 已过天数）；拿不到才退回近 7 天本地均值。
          //    用户反馈"应该看全周期的消耗"—— 只看最近几天会被突发流量带偏。
          const dailyUnitsFallback = avgDaily * unitsPerToken;
          const dailyUnits = periodDailyUnits ?? dailyUnitsFallback;
          const leftUnits = Math.max(0, limit - usedUnits);
          if (dailyUnits > 0) daysToExhaust = leftUnits / dailyUnits;
          // ⚠ 算 exhaustDate 前必须挡住超出 Date 范围的天数：
          //   `new Date(t + days*86400000)` 超过 ±8.64e15 ms 会得到 Invalid Date。
          //   实测踩到：额度充裕时 daysToExhaust ≈ 1e8 天 → Invalid Date，
          //   于是下面的 `end < Invalid Date` 恒为 false → 误判成"额度先耗尽"。
          //   用 MAX_SAFE_DAYS 兜住（约 1 亿天已远超任何套餐周期）。
          const MAX_SAFE_DAYS = 1e8;
          if (daysToExhaust !== null) {
            const d = new Date(now.getTime() + Math.min(daysToExhaust, MAX_SAFE_DAYS) * 86400000);
            exhaustDate = Number.isNaN(d.getTime()) ? null : d;
          }
          // 套餐到期时间（periodEnd 是 "YYYY-MM-DD HH:mm:ss"）
          const end = summary?.plan?.periodEnd ? new Date(String(summary.plan.periodEnd).replace(" ", "T")) : null;
          const endValid = end && !Number.isNaN(end.getTime());
          // 判"谁先到"用**天数**比，别用 Date 比较 —— 上面那个溢出就是教训。
          const daysToEnd = endValid ? (end.getTime() - now.getTime()) / 86400000 : null;
          exhausted = daysToEnd !== null && daysToExhaust !== null && daysToEnd < daysToExhaust
            ? "expiry"
            : "units";
        }

        return {
          avgDaily,
          sampleDays,
          thinSample: sampleDays < 3,
          projectedMonth,
          // 预测月底剩余：**换算成同一单位后再算**
          projectedRemain: limit > 0
            ? Math.max(0, limit - (unitsPerToken > 0 ? projectedMonth * unitsPerToken : limit))
            : null,
          overBudget: limit > 0 && unitsPerToken > 0 && projectedMonth * unitsPerToken > limit,
          // 额度耗尽预测
          unitsPerToken,
          // 日均用的是哪种口径：'period'（全周期，官方累计）| 'recent'（本地近 7 天）
          rateBasis: periodDailyUnits !== null ? "period" : "recent",
          dailyUnits: periodDailyUnits ?? (unitsPerToken > 0 ? avgDaily * unitsPerToken : null),
          elapsedDays,
          periodUsed,
          daysToExhaust,
          exhaustDate,
          exhausted,            // 'units'（先用完）| 'expiry'（先到期）
          leftUnits: limit > 0 ? Math.max(0, limit - usedUnits) : null,
        };
      }, [local, unit, summary]);

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
        const isMimo = (p, m) => isMiMoEntry(p, m);
        const models = Array.isArray(session.models) ? session.models : [];
        if (models.length === 0) return null;
        // 只有单一 MiMo 渠道时，整会话的 input/output 就是 MiMo 的，可精确计算
        const onlyMimo = models.every((m) => isMimo(m.provider, m.model));
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
        return models.length > 0 && !models.every((m) => isMiMoEntry(m.provider, m.model));
      }, [session]);

      // 响应式：窄屏（竖屏手机）改为单列 + 紧凑间距 + 可横滚表格。
      //
      // ⚠️ 这些 hook 必须在任何提前 return 之前调用：React 要求每次渲染的 hook
      // 调用数量与顺序完全一致，放到 `if (loading) return …` 之后会导致
      // "Rendered more hooks than during the previous render" 崩溃。
      const { narrow } = useViewport();
      const prefs = useUiPrefs();

      // ── 可选的「非 MiMo 时隐藏详情页」门 ──────────────────────────────
      //
      // 与胶囊可见性同源（host 的地址级结论优先，名字兜底）。用户开启
      // `hideViewWhenNotMiMo` 后，当前模型不是 MiMo 时整个 tab 不再有内容。
      //
      // ⚠ 这里返回 null 而**不是注销槽位注册** —— 平台自己的插件
      // （如 `dsh-codebuddy`）就是这么做的：`conversation.view` 的 label/顺序
      // 属于注册元数据，频繁注销/重注册会让标签行闪烁；而组件返回 null 时
      // tab 内容为空、开销极小。**别改成动态注销**。
      //
      // ⚠ 必须在所有 hook 之后（本函数上方已有 useState/useEffect/useCallback/
      // useMemo/useViewport/useUiPrefs），否则 hook 数量随渲染变化会崩。
      const hideByPref = prefs.hideViewWhenNotMiMo === true;
      const viewSelection = (() => {
        try {
          if (typeof props?.useProjection !== "function") return null;
          const hit = props.useProjection("modelSelection")?.next ?? props.useProjection("modelSelection")?.lastUsed;
          if (!hit) return null;
          return {
            provider: typeof hit.provider === "string" ? hit.provider : undefined,
            model: typeof hit.model === "string" ? hit.model : undefined,
          };
        } catch {
          return null;
        }
      })();
      if (hideByPref) {
        const hostSays = typeof summary?.isMiMo === "boolean" ? summary.isMiMo : undefined;
        const sameProvider = summary?.provider && summary.provider === viewSelection?.provider;
        // host 结论只对它自己那个 provider 有效；否则按名字兜底
        const isMimo = hostSays !== undefined && sameProvider
          ? hostSays
          : viewSelection
            ? isMiMoEntry(viewSelection.provider, viewSelection.model)
            : currentModel
              ? isMiMoEntry(currentModel.provider, currentModel.model)
              : true; // 读不到 → 保守显示（与胶囊同策略）
        if (!isMimo) {
          return h(
            "div",
            {
              style: {
                padding: narrow ? "18px 14px" : "24px 22px",
                fontSize: "13px",
                lineHeight: 1.7,
                color: "var(--dsw-alias-label-tertiary, #59636e)",
              },
            },
            t("view.hiddenNotMimo"),
          );
        }
      }

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
      // Credits 柱的归一化上限（有分项数据时用 Credits 口径）
      const hasCreditDays = days.some((d) => Number.isFinite(d.credits));
      // 两套归一化上限：Credits 柱与 tokens 柱各自独立（单位不同，不能共用）
      const maxCredits = hasCreditDays ? Math.max(...days.map((d) => d.credits ?? 0), 1) : 1;
      // 🔴 三段颜色的**唯一来源**：图例色块与柱子分段都从这里取。
      // 曾各自写一份 —— 图例只是文字里的 "■"（用整行的 tertiary 文字色 = 三块全灰），
      // 柱段却各是绿/黄/蓝 ⇒ 用户看不出哪块对哪段（"根本没对应上柱状图上的颜色"）。
      // 拆成两份就一定会再次漂移，所以只留这一个 map。
      const CREDIT_COLORS = {
        cache: "var(--dsw-alias-state-success-primary, #1a7f37)",
        miss: "var(--dsw-alias-state-warning-primary, #d4a72c)",
        out: "var(--dsw-alias-state-business-primary, #0969da)",
      };
      // 顺序 = 柱内堆叠顺序（column-reverse 时自上而下为 输出 → 未命中 → 缓存命中）
      const CREDIT_LEGEND = [
        ["cache", t("view.legendCache")],
        ["miss", t("view.legendMiss")],
        ["out", t("view.legendOut")],
      ];
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
          // ── 根容器：必须与平台 `viewArea` 的 flex 语义对齐 ──────────────
          //
          // 平台把 view 挂在 `.viewArea` 里，那是个 **flex 纵向容器**：
          //     .viewArea { flex-direction: column; flex: 1; min-height: 0; display: flex }
          // 而**滚动由外层 `.scrollBody` 负责**（`flex:1; overflow-y:auto`）。
          //
          // ⚠ 根元素若不声明 `flex:1`/`min-height:0`，作为 flex item 会**按内容
          // 高度收缩**；而 `.viewArea` 又带 `overflow:hidden` ⇒ 内容一长就被**裁掉**。
          // 这正是"和轨迹页展示不一样"的根因。
          //
          // ✅ 对齐轨迹页的根（`views.ledger`：
          //    `flex:1; min-width:0; min-height:0; display:flex`）：
          //    **撑满 + 允许被压缩**，但**不自己滚** ——
          //    滚动由平台的 `.scrollBody`（`flex:1; overflow-y:auto`）负责，
          //    这也是 chat / 轨迹两个官方视图的共同行为。
          //
          // ⚠ 别在这里加 `overflow:auto`：那会多出一个内层滚动条，出现"双滚动"，
          //    与官方视图的观感不一致（我第一版就这么写错了）。
          //
          // 🔴 **绝不能加 `data-conversation-composer-overlay`**（09-28 为此改了两次）。
          //
          // 我一度加上它，因为它能隐藏 widthHandle（平台规则：
          //   `.root:has([data-conversation-composer-overlay]) .widthHandle{display:none}`）。
          // 但该属性真正的语义是「**本视图自带滚动容器**」，加了之后平台改两条布局：
          //   .viewArea   { flex:1 1 0; min-height:0; overflow:hidden }  ← 锁成固定高度
          //   .scrollBody { overflow:hidden auto }
          // 轨迹页加它没事，是因为它内部**真的**有滚动容器（`.tablePane`：
          // `flex:1; overflow:hidden auto`）；我们内部没有 ⇒ 视图被锁死、内容被裁，
          // 表现为**详情页不能上下滚动**。
          //
          // ✅ 正确做法：不加该属性（保住正常滚动），widthHandle 用我们自己的 CSS
          //    隐藏 —— 见 applyHideResizeHandles()。
          style: {
            // 撑满平台给的 flex 容器，并允许在空间不足时收缩
            flex: "1 0 auto",
            minHeight: 0,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            // 窄屏收窄内边距，把宽度让给内容
            padding: narrow ? "12px 12px 96px" : "16px 22px 40px",
            // 可读宽度：与平台其它视图一致（列方向 flex 里 `margin:0 auto` 会水平居中）
            maxWidth: "1100px",
            margin: "0 auto",
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
                onClick: () => openPluginPage(),
                title: t("view.openSettingsHint"),
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
              t("view.openSettings"),
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
        // 数据来源行。
        // ⚠ 官方失败时**不要**把原始错误串直接铺出来 —— 它是
        // `balance: HTTP 401: {"code":401,"loginUrl":"https://account.xiaomi.com/..."}`
        // 这种形态，几百字符、含长 URL，会把布局撑乱而且用户读不懂。
        // 登录失效（401）单独走下面的提示条，其余失败只给一句简短原因。
        h(
          "div",
          { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)", marginBottom: "14px" } },
          summary?.official
            ? (summary.stale
                ? t("view.staleSource", {
                    time: summary.staleAt ? fmtTime(summary.staleAt) : "—",
                  })
                : t("view.official"))
            : summary
              ? (summary.authExpired ? t("view.localGeneric") : `${t("view.local")} · ${shortError(summary.officialError)}`)
              : "",
        ),
        // ── A：登录失效提示条（带「重新登录」入口）────────────────────────
        // Cookie 是浏览器会话产物，会过期；过期后三个官方接口都 401，
        // 数据静默退化成「本地估算」。用户看到的现象是"套餐总量怎么变回我手填的了"，
        // 却不知道要重新登录 —— 所以这里必须**主动说破**并给出下一步。
        authExpired
          ? h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "10px 12px",
                  marginBottom: "14px",
                  borderRadius: "8px",
                  background: "var(--dsw-alias-bg-modal, #fff8e6)",
                  border: "1px solid var(--dsw-alias-state-warning-primary, #d4a72c)",
                  fontSize: "12px",
                  lineHeight: 1.6,
                },
              },
              h("span", { style: { fontSize: "15px", lineHeight: 1.2 } }, "⚠"),
              h(
                "div",
                { style: { flex: "1 1 auto", minWidth: 0 } },
                h("div", { style: { fontWeight: 600, marginBottom: "3px" } }, t("view.authExpiredTitle")),
                h(
                  "div",
                  { style: { color: "var(--dsw-alias-label-secondary, #59636e)" } },
                  // 有缓存 → 说明"现在显示的是缓存数据"；没缓存 → 才是本地估算
                  stale
                    ? t("view.authExpiredStale", {
                        time: staleAt ? fmtTime(staleAt) : "—",
                      })
                    : t("view.authExpiredHint"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      // 滚到页面底部的配置表单并聚焦 Cookie 输入框
                      const el = document.getElementById("mimo-cookie-input");
                      if (el && typeof el.scrollIntoView === "function") {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                      }
                      if (el && typeof el.focus === "function") el.focus();
                    },
                    style: {
                      marginTop: "6px",
                      padding: "4px 10px",
                      fontSize: "12px",
                      borderRadius: "6px",
                      border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
                      background: "var(--dsw-alias-bg-layer-1, #fff)",
                      color: "var(--dsw-alias-label-primary, #1f2328)",
                      cursor: "pointer",
                    },
                  },
                  t("view.authExpiredAction"),
                ),
              ),
            )
          : null,
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
                    h(Stat, {
                      label: t("view.usedPercentFrame", { frame: quotaFrame }),
                      value: `${fmtPercent(unit.percent)}%`,
                      accent: true,
                    }),
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
                    // 单位跟在各自数字后面，不要单独挂一个 span 在行尾 ——
                    // 那样读者分不清它修饰的是「已用」还是「总量」。
                    h(
                      "span",
                      null,
                      `${t("view.used")}：${fmtFull(unit.used)}${planUsageUnit ? ` ${planUsageUnit}` : ""}`,
                    ),
                    h(
                      "span",
                      null,
                      `${t("view.limit")}：${fmtFull(unit.limit)}${planUsageUnit ? ` ${planUsageUnit}` : ""}`,
                    ),
                    // host 给的 label 是「本月套餐额度」，对年付套餐不成立
                    //（见上面的周期口径说明）—— 年付时改说「套餐额度（年度）」。
                    unit.label
                      ? h("span", null, isYearlyPlan ? t("view.quotaYearlyLabel") : unit.label)
                      : null,
                    summary?.plan?.planCode ? h("span", null, `${t("view.planCode")}：${summary.plan.planCode}`) : null,
                    summary?.plan?.periodEnd ? h("span", null, `${t("view.periodEnd")}：${summary.plan.periodEnd}`) : null,
                    summary?.plan?.expired
                      ? h("span", { style: { color: "var(--dsw-alias-state-error-primary, #cf222e)" } }, t("view.expired"))
                      : null,
                    // 年付套餐说明（用户反馈"本月套餐额度"误导）：年付没有月度子限额，
                    // 额度整个周期共用 —— 不说明，用户会以为每月重置。
                    isYearlyPlan
                      ? h(
                          "div",
                          {
                            style: {
                              marginTop: "8px",
                              fontSize: FS.label,
                              lineHeight: 1.6,
                              color: "var(--dsw-alias-label-tertiary, #59636e)",
                            },
                          },
                          t("view.yearlyNote"),
                        )
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
                    // 三行都是**人民币金额**：币种标在数字后（标签行留给"总额/现金/赠金"）
                    h(Stat, { label: t("view.balance"), value: summary.balance.balance,
                              unit: summary.balance.currency, accent: true }),
                    h(Stat, { label: t("view.cash"), value: summary.balance.cashBalance,
                              unit: summary.balance.currency }),
                    h(Stat, { label: t("view.gift"), value: summary.balance.giftBalance,
                              unit: summary.balance.currency }),
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
                    // 这几个都是**原始 token 数**（不是 Credits），统一标 tokens，
                    // 免得跟套餐卡的 Credits 混为一谈。
                    h(Stat, { label: t("view.tokens"), value: fmtFull(sessTokens), unit: "tokens", accent: true }),
                    h(Stat, { label: t("view.calls"), value: fmtFull(sessCalls), unit: t("view.callsUnit") }),
                    h(Stat, { label: t("view.input"), value: fmtFull(session.inputTokens), unit: "tokens" }),
                    h(Stat, { label: t("view.output"), value: fmtFull(session.outputTokens), unit: "tokens" }),
                    h(Stat, { label: t("view.cacheRead"), value: fmtFull(session.cacheReadTokens), unit: "tokens" }),
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
                                const mimo = isMiMoEntry(m.provider, m.model);
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
                  // flex:1 + minHeight:0：认领卡片里除标题外的全部剩余高度，
                  // 好让下面的柱状图把空白吃掉（而不是堆在顶部、底部留一片空）。
                  { style: { display: "flex", flexDirection: "column", gap: "10px", flex: "1 1 auto", minHeight: 0 } },
                  h(
                    Row,
                    null,
                    // 主指标：Credits 估算（有分项才能算；否则退回 tokens）
                    local.days.some((d) => Number.isFinite(d.credits))
                      ? h(Stat, {
                          label: t("view.todayCredits"),
                          value: fmtFull(local.days.find((d) => d.date === local.today)?.credits ?? 0),
                          unit: "Credits·估",
                          accent: true,
                        })
                      : h(Stat, { label: t("view.today"), value: fmtFull(local.todayTokens), unit: "tokens", accent: true }),
                    local.monthCredits !== undefined
                      ? h(Stat, { label: t("view.monthCredits"), value: fmtFull(local.monthCredits), unit: "Credits·估", accent: true })
                      : h(Stat, { label: t("view.month"), value: fmtFull(local.monthTokens), unit: "tokens", accent: true }),
                  ),
                  days.length
                    ? h(
                        "div",
                        { style: { display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 auto", minHeight: 0 } },
                        // 图例：Credits 堆叠柱的三段含义（仅有分项数据时）
                        hasCreditDays
                          ? h(
                              "div",
                              { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", fontSize: "10.5px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                              // 可点击的图例项：色块直接取 CREDIT_COLORS[k]（与柱段同源）；
                              // 点一下 = 高亮该分段（变大一圈）、其余压暗；再点同项取消。
                              ...CREDIT_LEGEND.map(([k, label]) =>
                                h(
                                  "span",
                                  {
                                    key: k,
                                    role: "button",
                                    "aria-pressed": legendPick === k,
                                    title: t("view.legendHint"),
                                    onClick: () => setLegendPick((prev) => (prev === k ? null : k)),
                                    style: {
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "5px",
                                      cursor: "pointer",
                                      padding: "1px 7px",
                                      borderRadius: "999px",
                                      border: `1px solid ${legendPick === k ? CREDIT_COLORS[k] : "transparent"}`,
                                      background: legendPick === k ? "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04))" : "transparent",
                                      color:
                                        legendPick === k
                                          ? "var(--dsw-alias-label-primary, #1f2328)"
                                          : "var(--dsw-alias-label-tertiary, #59636e)",
                                      fontWeight: legendPick === k ? 650 : 400,
                                      opacity: legendPick && legendPick !== k ? 0.6 : 1,
                                      userSelect: "none",
                                    },
                                  },
                                  h("span", {
                                    style: { width: "9px", height: "9px", borderRadius: "2px", flex: "none", background: CREDIT_COLORS[k] },
                                  }),
                                  label,
                                ),
                              ),
                              // 说明夜间折扣已建模 —— 否则用户自己按倍率算会对不上
                              h(
                                "span",
                                { style: { opacity: 0.75 } },
                                t("view.legendOffPeak"),
                              ),
                            )
                          : null,
                        h(
                          "div",
                          {
                            style: {
                              display: "flex",
                              gap: narrow ? "2px" : "4px",
                              alignItems: "flex-end",
                              flex: "1 1 auto",
                              minHeight: narrow ? "46px" : "60px",
                              overflowX: narrow ? "auto" : undefined,
                            },
                          },
                          days.map((d, i) => {
                            // Credits 分项 → 每根柱堆叠三段：绿=缓存命中(2/M)、
                            // 黄=未命中输入(100/M)、蓝=输出(200/M)。
                            // 一眼看出消耗构成：黄色占大头 = 缓存命中率低。
                            const hasCredits = Number.isFinite(d.credits);
                            const parts = hasCredits
                              ? [
                                  { k: "cache", v: d.cCache ?? 0 },
                                  { k: "miss", v: d.cMiss ?? 0 },
                                  { k: "out", v: d.cOut ?? 0 },
                                ]
                              : null;
                            const pctH = hasCredits
                              ? Math.max(4, Math.round(((d.credits ?? 0) / maxCredits) * 100))
                              : Math.max(4, Math.round((d.tokens / maxDay) * 100));
                            return h(
                              "div",
                              {
                                key: i,
                                title: hasCredits
                                  ? `${d.date}：${fmtFull(d.credits)} Credits（${t("view.legendCache")} ${fmtFull(d.cCache)} / ${t("view.legendMiss")} ${fmtFull(d.cMiss)} / ${t("view.legendOut")} ${fmtFull(d.cOut)}）`
                                  : `${d.date}：${fmtFull(d.tokens)} tokens`,
                                style: {
                                  width: narrow ? "10px" : "15px",
                                  flex: narrow ? "none" : undefined,
                                  height: `${pctH}%`,
                                  minHeight: "3px",
                                  maxHeight: "100%",
                                  display: "flex",
                                  flexDirection: "column-reverse",
                                  gap: "1px",
                                  borderRadius: "3px",
                                  // 点选高亮时放开裁剪，让选中段的外圈光晕能溢出
                                  //（未选中态照旧 hidden 保住圆角裁剪）
                                  overflow: legendPick ? "visible" : "hidden",
                                  position: legendPick ? "relative" : undefined,
                                  zIndex: legendPick ? 1 : undefined,
                                },
                              },
                              parts
                                ? parts.filter((p) => p.v > 0).map((p, kk) =>
                                    h("div", {
                                      key: kk,
                                      style: {
                                        flex: `${p.v}`,
                                        background: CREDIT_COLORS[p.k],
                                        minHeight: "2px",
                                        // ★ "变大一圈"：同色外扩 2px 光晕；未选中的段压暗
                                        ...(legendPick
                                          ? legendPick === p.k
                                            ? { boxShadow: `0 0 0 2px ${CREDIT_COLORS[p.k]}`, position: "relative", zIndex: 2 }
                                            : { opacity: 0.22 }
                                          : {}),
                                      },
                                    }),
                                  )
                                // 该日没有 Credits 分项（早于 Credits 建模的旧数据 / 缺单价
                                // 的那天）：退回单根 tokens 柱。原先是 `: null` —— 那几天
                                // 柱高算出来了却是**空柱**（什么都看不到）。
                                : h("div", {
                                    style: {
                                      height: "100%",
                                      background: "var(--dsw-alias-state-business-primary, #0969da)",
                                      opacity: legendPick ? 0.22 : 0.85,
                                    },
                                  }),
                            );
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
                            // 预测区固定在底部：让上面的柱状图（flex:1）独占剩余空间
                            flex: "none",
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
                            unit: "tokens",
                          }),
                          // ⚠ 这两个是 **tokens**，紧挨着的"预计月底剩余"是 **Credits** ——
                          //    三种口径并排放，必须每个都标，否则用户会以为能直接相减。
                          h(Stat, {
                            label: t("view.projected"),
                            value: fmtFull(forecast.projectedMonth),
                            unit: "tokens",
                          }),
                          forecast.projectedRemain !== null
                            ? h(Stat, {
                                label: t("view.projectedRemain"),
                                value: fmtFull(forecast.projectedRemain),
                                unit: planUsageUnit,
                                accent: !forecast.overBudget,
                              })
                            : null,
                          // ── 预计何时耗尽额度（新增）─────────────────────────
                          // 官方规则："套餐在到期或全部 Credits 用完任一条件满足时即停止服务"，
                          // 所以这里给出的是**两者中先到的那个**，并说明是哪一个。
                          forecast.daysToExhaust !== null
                            ? h(Stat, {
                                label:
                                  forecast.exhausted === "expiry"
                                    ? t("view.exhaustsByExpiry")
                                    : t("view.exhaustsByQuota"),
                                value: forecast.daysToExhaust < 1
                                  ? t("view.exhaustsToday")
                                  : t("view.exhaustsValue", {
                                      // 带上年份：跨年套餐（本例年付，到期 2027）
                                      // 只写 "10/28" 会让人以为是今年。
                                      date: forecast.exhaustDate
                                        ? `${forecast.exhaustDate.getFullYear()}/${forecast.exhaustDate.getMonth() + 1}/${forecast.exhaustDate.getDate()}`
                                        : "—",
                                      days: Math.floor(forecast.daysToExhaust),
                                    }),
                                accent: forecast.daysToExhaust > 30,
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
                        // 耗尽预测的说明：讲清"到期或额度用完、先到即停"这条官方规则，
                        // 并说明推算依据 —— 否则用户会误以为这是官方给出的日期。
                        forecast.daysToExhaust !== null
                          ? h(
                              "div",
                              { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                              // 说明依哪种口径推算 —— 全周期（官方累计）与近 7 天结论可能差很多，
                              // 不说清楚用户没法判断这个日期可不可信。
                              forecast.rateBasis === "period"
                                ? t("view.exhaustsNotePeriod", { days: forecast.elapsedDays ?? 0 })
                                : t("view.exhaustsNoteRecent", {
                                    days: forecast.sampleDays > 0 ? forecast.sampleDays : 1,
                                  }),
                            )
                          : null,
                        // ── MiMo 模式省不省 Credits：切换前后日均对比 ──────
                        creditsCompare?.compare
                          ? (() => {
                              const c = creditsCompare.compare;
                              const saved = c.deltaPct !== null && c.deltaPct < 0;
                              const pct = c.deltaPct === null ? "—" : `${Math.abs(Math.round(c.deltaPct))}%`;
                              return h(
                                "div",
                                {
                                  style: {
                                    marginTop: "10px",
                                    paddingTop: "10px",
                                    borderTop: "1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.08))",
                                    fontSize: "11px",
                                    lineHeight: 1.7,
                                    color: "var(--dsw-alias-label-secondary, #59636e)",
                                  },
                                  "data-role": "mimo-mode-compare",
                                },
                                h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, t("view.modeCompareTitle")),
                                h("div", null, t("view.modeCompareLine", {
                                  before: fmtFull(c.beforeAvg),
                                  after: fmtFull(c.afterAvg),
                                  pct,
                                  dir: saved ? "↓" : "↑",
                                  bd: c.beforeDays,
                                  ad: c.afterDays,
                                })),
                                h("div", { style: { opacity: 0.8, marginTop: "2px" } }, t("view.modeCompareNote")),
                              );
                            })()
                          : creditsCompare && creditsCompare.modeTimeline?.length
                            ? h(
                                "div",
                                { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)", marginTop: "8px" } },
                                t("view.modeCompareNoData"),
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

        // 配置表单已迁到插件页（0.2 官方 plugins.row.config 槽）：
        // 侧栏「插件」→ dsh-mimo-extension → 配置。详情页只保留头部跳转入口。
      );
    }

    /**
     * 「MiMo 用量」页内的配置表单。
     *
     * 保存后写入 `settings.yaml` 的 `dsh-mimo-extension` 命名空间（宿主经 ctx.settings 持久化），
     * 优先级高于 patch 层 config，保存即热生效（宿主清缓存 → 胶囊下次刷新用新值）。
     *
     * Cookie 不回传明文：读取接口只返回「是否已配置 + 来源」，输入框留空表示保持不变。
     */
    function MimoSettingsForm({ onChange }) {
      const { narrow } = useViewport();
      const [cfg, setCfg] = useState(null);
      const [cookie, setCookie] = useState("");
      const [clearCookie, setClearCookie] = useState(false);
      // ── B：半自动登录 ──────────────────────────────────────────────
      // 小米只给网页 SSO（account.xiaomi.com/pass/serviceLogin），**没有 OAuth
      // 端点、没有设备码、没有 refresh token**，插件无从自动换取凭据；
      // 官方额度接口也**只认 Cookie，不认 API Key**（实测 Bearer 一律 401）。
      // 所以这里能做的是「把手工步骤讲清楚 + 存之前先验一遍」，
      // 而不是假装能一键登录。
      const [guideOpen, setGuideOpen] = useState(false);
      // 风险确认弹窗（用户要求"交由用户确认"）：true 才显示确认块，
      // 点「我已了解风险」后才真正调 /save-cookie。
      const [vaultConfirm, setVaultConfirm] = useState(false);
      // {kind:'ok'|'err'|'busy', text, detail?} —— 校验结果
      const [verify, setVerify] = useState(null);
      const [planTotal, setPlanTotal] = useState("");
      const [position, setPosition] = useState("header");
      const [wrapToolbar, setWrapToolbar] = useState(true);
      const [hideViewWhenNotMiMo, setHideViewWhenNotMiMo] = useState(false);
      const [visionRouting, setVisionRouting] = useState(false);
      const [visionMsg, setVisionMsg] = useState(null);
      const [visionTextModels, setVisionTextModels] = useState(false);
      // 第三开关：判定为 MiMo 渠道（resolveMiMoChannel：地址优先、名字兜底）上的
      // 全部模型都声明 image —— 覆盖别名模型与未来新模型。
      const [visionAllMimo, setVisionAllMimo] = useState(false);
      // 「MiMo 模式」会话预设开关（安装/移除 ~/.agent-presets/dsh-mimo-mode）
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
            setHideViewWhenNotMiMo(data.hideViewWhenNotMiMo === true);
            setVisionRouting(data.visionRouting === true);
            setVisionTextModels(data.visionRoutingTextModels === true);
            setVisionAllMimo(data.visionRoutingAllMimo === true);
          })
          .catch((error) => {
            if (alive) setMessage({ kind: "err", text: error instanceof Error ? error.message : String(error) });
          });
        return () => {
          alive = false;
        };
      }, []);

      /**
       * 校验当前输入框里的 Cookie 是否真的可用 —— **保存前**先验。
       *
       * 为什么值得单独做：Cookie 是 500 字符的长串，粘错一个字符看不出来；
       * 存进去之后只表现为「一直显示本地估算」，用户根本不知道哪一步错了。
       * 这里拿候选值真打一次官方接口，把结论（含套餐码/额度）当场说清楚。
       */
      const verifyCookie = useCallback(async () => {
        const candidate = cookie.trim();
        if (!candidate) {
          setVerify({ kind: "err", text: t("cfg.verifyEmpty") });
          return;
        }
        setVerify({ kind: "busy", text: t("cfg.verifying") });
        try {
          const r = await rpc("validate-cookie", { cookie: candidate }, "POST");
          if (r?.valid) {
            setVerify({
              kind: "ok",
              text: t("cfg.verifyOk"),
              detail: r.planCode
                ? t("cfg.verifyPlan", {
                    code: r.planCode,
                    end: r.periodEnd || "—",
                    used: fmtFull(r.used ?? 0),
                    limit: fmtFull(r.limit ?? 0),
                    unit: r.unit || "",
                  })
                : "",
            });
          } else if (r?.unauthorized) {
            setVerify({ kind: "err", text: t("cfg.verifyExpired"), detail: shortError(r.error) });
          } else {
            setVerify({ kind: "err", text: t("cfg.verifyFail"), detail: shortError(r?.error) });
          }
        } catch (e) {
          setVerify({ kind: "err", text: t("cfg.verifyFail"), detail: shortError(e instanceof Error ? e.message : String(e)) });
        }
      }, [cookie]);

      const save = useCallback(async () => {
        setBusy(true);
        setMessage(null);
        try {
          const payload = {
            planTotalTokens: Number(planTotal) || 0,
            pillPosition: position,
            wrapToolbar,
            hideViewWhenNotMiMo,
            visionRouting,
            visionRoutingTextModels: visionTextModels,
            visionRoutingAllMimo: visionAllMimo,
          };
          // Cookie 留空 = 不改；勾选清除 = 写空串
          if (clearCookie) payload.cookie = "";
          else if (cookie.trim()) payload.cookie = cookie.trim();
          const saved = await rpc("settings", undefined, "POST", payload);
          setCookie("");
          setClearCookie(false);
          const fresh = await rpc("settings").catch(() => null);
          if (fresh) {
            setCfg(fresh);
            setPlanTotal(String(fresh.planTotalTokens ?? ""));
          }
          setUiPrefs({ position, wrapToolbar, hideViewWhenNotMiMo, visionRouting });
          // 视觉路由是**跨命名空间写入**（改 llm-pi-ai 的模型声明），可能失败
          // （设置服务只读 / 命名空间未注册）。失败必须说出来，不能只报"已保存"，
          // 否则用户以为开了视觉却一直发不出图。
          const vErr = saved?.visionError;
          const vChanged = Array.isArray(saved?.visionChanged) ? saved.visionChanged : [];
          if (vErr) {
            setVisionMsg({ kind: "err", text: t("cfg.visionFailed", { error: vErr }) });
            setMessage({ kind: "err", text: t("cfg.visionFailed", { error: vErr }) });
          } else if (visionRouting && vChanged.length) {
            setVisionMsg({ kind: "ok", text: t("cfg.visionOn", { list: vChanged.join(", ") }) });
            setMessage({ kind: "ok", text: t("cfg.saved") });
          } else if (!visionRouting && vChanged.length) {
            setVisionMsg({ kind: "ok", text: t("cfg.visionOff", { list: vChanged.join(", ") }) });
            setMessage({ kind: "ok", text: t("cfg.saved") });
          } else {
            setVisionMsg(null);
            setMessage({ kind: "ok", text: t("cfg.saved") });
          }
          if (typeof onChange === "function") onChange();
        } catch (error) {
          setMessage({ kind: "err", text: t("cfg.saveFailed", { error: error instanceof Error ? error.message : String(error) }) });
        } finally {
          setBusy(false);
        }
      }, [cookie, clearCookie, planTotal, position, wrapToolbar, hideViewWhenNotMiMo, visionRouting, visionTextModels, visionAllMimo, onChange]);

      /**
       * 把当前输入的 Cookie **安全保存到 DSH 凭据库**（.credentials.yaml，0600）。
       *
       * 链路：POST /save-cookie → host 先真打官方接口校验 → 通过才写凭据库
       *       → 清官方缓存 → 响应**只回引用名，绝不回显 Cookie**。
       *
       * 安全要点：
       *   · 明文不进 settings.yaml（settings 里只有 cookieRef 引用名）
       *   · 只在通过官方接口校验后才落库（写入拒绝空值，见 credentials provider）
       *   · 输入框立刻清空（不把凭据留在内存/界面上）
       */
      const saveToVault = useCallback(async () => {
        const candidate = cookie.trim();
        if (!candidate) {
          setVerify({ kind: "err", text: t("cfg.verifyEmpty") });
          return;
        }
        setBusy(true);
        setVerify({ kind: "busy", text: t("cfg.verifying") });
        try {
          const r = await rpc("save-cookie", { cookie: candidate }, "POST");
          if (r?.saved && r?.valid) {
            setVerify({ kind: "ok", text: t("cfg.cookieVaultSaved", { ref: r.ref ?? "" }) });
            // 凭据已进库：清空输入框，界面不再持有明文
            setCookie("");
            setClearCookie(false);
            const fresh = await rpc("settings").catch(() => null);
            if (fresh) setCfg(fresh);
            if (typeof onChange === "function") onChange();
          } else if (r && r.valid === false) {
            setVerify({ kind: "err", text: t("cfg.cookieInvalid", { error: shortError(r.error) }) });
          } else {
            setVerify({ kind: "err", text: t("cfg.cookieInvalid", { error: shortError(r?.error) }) });
          }
        } catch (e) {
          setVerify({
            kind: "err",
            text: t("cfg.cookieVaultFailed", { error: shortError(e instanceof Error ? e.message : String(e)) }),
          });
        } finally {
          setBusy(false);
        }
      }, [cookie, onChange]);

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
                // 详情页顶部的「重新登录」按钮靠这个 id 滚过来并聚焦
                id: "mimo-cookie-input",
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

            // ── B：登录引导 + 保存前校验 ───────────────────────────────
            // 把「去哪拿 Cookie」的步骤摊在界面上，并允许当场验证。
            // 说明白为什么不能一键登录（小米没有 OAuth），用户才不会觉得是插件偷懒。
            h(
              "div",
              { style: { marginTop: "8px" } },
              h(
                "div",
                { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
                h(
                  "button",
                  {
                    type: "button",
                    onClick: () => setGuideOpen((v) => !v),
                    style: {
                      padding: "4px 10px",
                      fontSize: "12px",
                      borderRadius: "6px",
                      border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
                      background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                      color: "inherit",
                      cursor: "pointer",
                    },
                    "data-role": "login-guide-toggle",
                  },
                  guideOpen ? t("cfg.guideHide") : t("cfg.guideShow"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    disabled: busy || clearCookie || !cookie.trim(),
                    onClick: verifyCookie,
                    style: {
                      padding: "4px 10px",
                      fontSize: "12px",
                      borderRadius: "6px",
                      border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
                      background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                      color: "inherit",
                      cursor: busy || clearCookie || !cookie.trim() ? "not-allowed" : "pointer",
                      opacity: busy || clearCookie || !cookie.trim() ? 0.5 : 1,
                    },
                    "data-role": "verify-cookie",
                  },
                  t("cfg.verify"),
                ),
                verify
                  ? h(
                      "span",
                      {
                        style: {
                          fontSize: "11px",
                          color:
                            verify.kind === "ok"
                              ? "var(--dsw-alias-state-success-primary, #1a7f37)"
                              : verify.kind === "err"
                                ? "var(--dsw-alias-state-error-primary, #cf222e)"
                                : "var(--dsw-alias-label-tertiary, #59636e)",
                        },
                        "data-role": "verify-result",
                      },
                      verify.text,
                    )
                  : null,
              ),
              verify?.detail
                ? h(
                    "p",
                    {
                      style: {
                        margin: "4px 0 0",
                        fontSize: "11px",
                        lineHeight: 1.6,
                        color: "var(--dsw-alias-label-tertiary, #59636e)",
                        wordBreak: "break-all",
                      },
                    },
                    verify.detail,
                  )
                : null,
              guideOpen
                ? h(
                    "div",
                    {
                      style: {
                        marginTop: "8px",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))",
                        fontSize: "11px",
                        lineHeight: 1.8,
                        color: "var(--dsw-alias-label-secondary, #59636e)",
                      },
                      "data-role": "login-guide",
                    },
                    h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("cfg.guideTitle")),
                    h("div", null, t("cfg.guideStep1")),
                    h("div", null, t("cfg.guideStep2")),
                    h("div", null, t("cfg.guideStep3")),
                    h("div", null, t("cfg.guideStep4")),
                    h(
                      "div",
                      { style: { marginTop: "6px", opacity: 0.85 } },
                      t("cfg.guideWhyManual"),
                    ),
                    // 风险说明（用户要求"做好风险说明，交由用户确认"）——
                    // 与引导同区展示，措辞与「保存到凭据库」的确认弹窗一致。
                    h(
                      "div",
                      {
                        style: {
                          marginTop: "8px",
                          paddingTop: "8px",
                          borderTop: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
                        },
                        "data-role": "cookie-risk",
                      },
                      h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("cfg.cookieRiskTitle")),
                      h(
                        "div",
                        { style: { whiteSpace: "pre-line" } },
                        t("cfg.cookieRiskBody"),
                      ),
                    ),
                    h(
                      "a",
                      {
                        // 直达「余额」控制台页：登录后第一屏就是 /api/v1 请求，比落地页少一步跳转。
                        href: "https://platform.xiaomimimo.com/console/balance",
                        target: "_blank",
                        rel: "noreferrer noopener",
                        style: {
                          display: "inline-block",
                          marginTop: "6px",
                          color: "var(--dsw-alias-state-business-primary, #0969da)",
                          textDecoration: "none",
                        },
                      },
                      t("cfg.guideOpenConsole"),
                    ),
                  )
                : null,
              // 「安全保存到凭据库」：把当前输入的 Cookie 先校验、再写进 DSH 凭据库
              // （.credentials.yaml，0600），**明文不进 settings.yaml**。
              // 必须经用户确认（风险弹窗）后才发请求 —— 见 vaultConfirm 状态。
              h(
                "div",
                { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "6px", flexWrap: "wrap" } },
                h(
                  "button",
                  {
                    type: "button",
                    disabled: busy || !cookie.trim() || cfg?.vaultAvailable === false,
                    title:
                      cfg?.vaultAvailable === false
                        ? t("cfg.cookieVaultUnavailable")
                        : t("cfg.cookieVaultHint"),
                    onClick: () => {
                      if (!cookie.trim()) {
                        setVerify({ kind: "err", text: t("cfg.verifyEmpty") });
                        return;
                      }
                      // 用户确认制：先弹风险确认，确认后才真正写库
                      setVaultConfirm(true);
                    },
                    style: {
                      padding: "5px 12px",
                      fontSize: "12px",
                      borderRadius: "8px",
                      border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
                      background: "var(--dsw-alias-bg-layer-1, #fff)",
                      color: "inherit",
                      cursor: "pointer",
                    },
                    "data-role": "cookie-vault-save",
                  },
                  t("cfg.cookieVault"),
                ),
                h(
                  "span",
                  { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                  cfg?.vaultAvailable === false ? t("cfg.cookieVaultUnavailable") : t("cfg.cookieVaultHint"),
                ),
                cfg?.cookieSource ? h(
                  "span",
                  { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                  t("cfg.cookieConfigured", { source: cfg.cookieSource }),
                ) : null,
              ),
              vaultConfirm
                ? h(
                    "div",
                    {
                      style: {
                        marginTop: "8px",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid var(--dsw-alias-state-warning-border, rgba(200,120,0,.35))",
                        background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))",
                        fontSize: "11px",
                        lineHeight: 1.7,
                      },
                      "data-role": "cookie-risk-confirm",
                    },
                    h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("cfg.cookieRiskTitle")),
                    h("div", { style: { whiteSpace: "pre-line" } }, t("cfg.cookieRiskBody")),
                    h(
                      "div",
                      { style: { display: "flex", gap: "8px", marginTop: "8px" } },
                      h(
                        "button",
                        {
                          type: "button",
                          disabled: busy,
                          onClick: async () => {
                            setVaultConfirm(false);
                            await saveToVault();
                          },
                          style: {
                            padding: "5px 12px",
                            fontSize: "12px",
                            borderRadius: "8px",
                            border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
                            background: "var(--dsw-alias-state-business-primary, #0969da)",
                            color: "#fff",
                            cursor: "pointer",
                          },
                          "data-role": "cookie-vault-confirm",
                        },
                        t("cfg.cookieRiskConfirm"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          onClick: () => setVaultConfirm(false),
                          style: {
                            padding: "5px 12px",
                            fontSize: "12px",
                            borderRadius: "8px",
                            border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
                            background: "var(--dsw-alias-bg-layer-1, #fff)",
                            color: "inherit",
                            cursor: "pointer",
                          },
                        },
                        t("cfg.cookieRiskCancel"),
                      ),
                    ),
                  )
                : null,
            ),
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

          // 非 MiMo 模型时隐藏详情页（可选，默认关闭）
          h(
            "label",
            { style: { fontSize: "12px", display: "flex", gap: "6px", alignItems: "flex-start", cursor: "pointer", lineHeight: 1.5 } },
            h("input", {
              type: "checkbox",
              checked: hideViewWhenNotMiMo,
              disabled: busy,
              onChange: (e) => {
                setHideViewWhenNotMiMo(e.currentTarget.checked);
                setMessage(null);
              },
              style: { marginTop: "2px" },
            }),
            h(
              "span",
              null,
              t("cfg.hideViewWhenNotMiMo"),
              h(
                "span",
                { style: { display: "block", opacity: 0.75, fontSize: "11px", marginTop: "2px" } },
                t("cfg.hideViewWhenNotMiMoHint"),
              ),
            ),
          ),

          // 启用 MiMo 视觉路由（可选，默认关闭）
          h(
            "label",
            { style: { fontSize: "12px", display: "flex", gap: "6px", alignItems: "flex-start", cursor: "pointer", lineHeight: 1.5 } },
            h("input", {
              type: "checkbox",
              checked: visionRouting,
              disabled: busy,
              onChange: (e) => {
                setVisionRouting(e.currentTarget.checked);
                setMessage(null);
                setVisionMsg(null);
              },
              style: { marginTop: "2px" },
            }),
            h(
              "span",
              null,
              t("cfg.visionRouting"),
              h(
                "span",
                { style: { display: "block", opacity: 0.75, fontSize: "11px", marginTop: "2px" } },
                t("cfg.visionRoutingHint"),
              ),
            ),
          ),
          // 子开关：为纯文本模型也补 image。**主开关关闭时禁用**（单独开没意义）。
          h(
            "label",
            {
              style: {
                fontSize: "12px",
                display: "flex",
                gap: "6px",
                alignItems: "flex-start",
                lineHeight: 1.5,
                marginLeft: "18px",
                cursor: visionRouting && !busy ? "pointer" : "default",
                opacity: visionRouting ? 1 : 0.5,
              },
            },
            h("input", {
              type: "checkbox",
              checked: visionTextModels,
              disabled: busy || !visionRouting,
              onChange: (e) => {
                setVisionTextModels(e.currentTarget.checked);
                setMessage(null);
                setVisionMsg(null);
              },
              style: { marginTop: "2px" },
            }),
            h(
              "span",
              null,
              t("cfg.visionTextModels"),
              h(
                "span",
                { style: { display: "block", opacity: 0.75, fontSize: "11px", marginTop: "2px" } },
                t("cfg.visionTextModelsHint"),
              ),
            ),
          ),
          // ── 第三开关：所有 MiMo 渠道的模型（别名/未来新模型也覆盖）─────
          // 与纯文本开关同层级、同"主开关关时禁用"的门。
          // ⚠ 风险最高（名字兜底判定不确信），默认关 + 文案写明。
          h(
            "label",
            {
              style: {
                fontSize: "12px",
                display: "flex",
                gap: "6px",
                alignItems: "flex-start",
                lineHeight: 1.5,
                marginLeft: "18px",
                cursor: visionRouting && !busy ? "pointer" : "default",
                opacity: visionRouting ? 1 : 0.5,
              },
            },
            h("input", {
              type: "checkbox",
              checked: visionAllMimo,
              disabled: busy || !visionRouting,
              onChange: (e) => {
                setVisionAllMimo(e.currentTarget.checked);
                setMessage(null);
                setVisionMsg(null);
              },
              style: { marginTop: "2px" },
              "data-role": "vision-all-mimo",
            }),
            h(
              "span",
              null,
              t("cfg.visionAllMimo"),
              h(
                "span",
                { style: { display: "block", opacity: 0.75, fontSize: "11px", marginTop: "2px" } },
                t("cfg.visionAllMimoHint"),
              ),
            ),
          ),
          visionMsg
            ? h(
                "div",
                {
                  style: {
                    fontSize: "11px",
                    lineHeight: 1.6,
                    marginLeft: "18px",
                    color:
                      visionMsg.kind === "err"
                        ? "var(--dsw-alias-state-error-primary, #cf222e)"
                        : "var(--dsw-alias-label-tertiary, #59636e)",
                  },
                },
                visionMsg.text,
              )
            : null,

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
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-mimo-extension: dictionaries");
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
    const WRAP_STYLE_ID = "dsh-mimo-extension-toolbar-wrap";
    const HIDE_HANDLE_STYLE_ID = "dsh-mimo-extension-hide-handles";
    /**
     * 隐藏会话外壳两侧的列宽拖拽手柄（`widthHandle`）。
     *
     * 为什么不用平台的 `data-conversation-composer-overlay`：它确实能隐藏手柄，
     * 但语义是"本视图自带滚动容器"，会把 `viewArea` 锁成 `overflow:hidden` 的
     * 固定高度 —— 我们没有内部滚动容器，结果详情页**滚不动**。
     * 所以这里只做一件事：把两个手柄藏掉。
     *
     * ⚠ 用 `display:none` 而不是 `pointer-events:none`：手柄是 40px 宽的
     * `cursor:col-resize` 覆盖层，只挡指针仍会改变光标形状、hover 竖线还会出现。
     */
    function applyHideResizeHandles(enabled) {
      if (typeof document === "undefined") return () => {};
      const existing = document.getElementById(HIDE_HANDLE_STYLE_ID);
      if (!enabled) {
        existing?.remove();
        return () => {};
      }
      if (existing) return () => {};
      const style = document.createElement("style");
      style.id = HIDE_HANDLE_STYLE_ID;
      style.dataset.plugin = "dsh-mimo-extension";
      // 按平台的**数据属性**选择（`data-width-handle`），不依赖哈希类名 ——
      // 平台重新构建后类名会变，数据属性不变。
      style.textContent = `
  /* dsh-mimo-extension：隐藏正文两侧的列宽拖拽手柄（本插件视图不需要它）。 */
  [data-conversation-scroll] [data-width-handle],
  [class*="_widthHandle"] {
    display: none !important;
  }
  `;
      document.head.appendChild(style);
      return () => style.remove();
    }

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
      style.dataset.plugin = "dsh-mimo-extension";
      style.textContent = `
  /* dsh-mimo-extension：输入框工具行允许换行，避免插件工具图标互相挤占重叠。
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
      timerCtx = ctx;
      layoutCtx = ctx;
      // 兼容旧包名/别名行残留，避免重复注册
      const entryName = ctx.fiber?.entry?.options?.name;
      // 兼容旧包名/别名行残留，避免重复注册：只有 entry 名明确**不是**本插件时才跳过。
      // ⚠️ 这里绝不能用严格相等判断 —— 宿主若用别名装载（"dsh-mimo-extension/client"、
      //    带路径后缀等），早退会让整颗插件静默消失：胶囊 + 详情页一起没了，
      //    而且一行日志都没有，表现为"装了没生效"。宁可多注册一次再靠下面的
      //    槽位去重兜底，也不要无声地整片关掉。
      if (typeof entryName === "string" && entryName.length > 0 && !/mimo-extension/i.test(entryName)) {
        probe("skipped", { entryName });
        console.warn(`[dsh-mimo-extension] 跳过装载：entry 名 "${entryName}" 不是本插件`);
        return;
      }
      probe("apply-entered", { entryName: String(entryName ?? "") });

      // 重复注册兜底（宿主可能因别名残留把同一插件载入两次）：
      // 槽位里已有本插件的 tab 就说明上一个 fiber 还活着，直接收手。
      try {
        const existing = ctx.slots.entriesOfSlot?.("conversation.view");
        if (Array.isArray(existing) && existing.some((entry) => entry?.options?.id === "mimo-extension")) {
          probe("skipped-duplicate", { entryName: String(entryName ?? "") });
          console.info("[dsh-mimo-extension] 已在槽位中注册过，跳过重复装载");
          return;
        }
      } catch {
        /* 老版本没有 entriesOfSlot 就当没有重复 */
      }

      bindLocale(ctx);

      // 1) 详情页 tab —— trajectory(10) 之后、额度(20) 之前
      // ── 1) 详情页 tab：**可注销**（供「非 MiMo 时隐藏」用）──────────────
      //
      // ⚠ 为什么必须注销、而不是像胶囊那样"组件返回提示"：
      // tab 行的文字**取自注册元数据的 `label`**，由平台这样构建列表
      // （`dsh-client-ui-conversation` 的 `viewTabs()`）：
      //     for (const entry of slots.entries("conversation.view"))
      //       tabs.push({ id, label: resolveSlotLabel(entry.options.label) ?? id })
      // 也就是说**组件渲染什么，tab 行根本看不到** —— 组件里返回 null/提示
      // 只能让内容变，**tab 照样在**。想让 tab 消失，唯一途径是注销注册。
      // 好在平台订阅了槽位变化（`slots.subscribe("conversation.view", refreshViews)`），
      // 注销/重注册会触发 tab 列表刷新 —— 这正是我们要的。
      // apply 层缓存的最近一次 summary（探针判定要用它的 isMiMo / provider）。
      // 由下面那次主动 `rpc("summary")` 填充；偏好保存后也会刷新。
      let latestSummary = null;

      let disposeView = null;
      let viewRegistered = false;
      const ensureView = (wantShown) => {
        if (wantShown === viewRegistered) return;
        if (!wantShown) {
          try {
            disposeView?.();
          } catch {
            /* 忽略卸载异常 */
          }
          disposeView = null;
          viewRegistered = false;
          return;
        }
        // 0.2 配置页：自带配置的插件把表单注册进**插件页**（ui-plugin-manager
        // README「配置页」的官方槽）。
        //
        // 🔴 键必须逐字等于平台自己拼的那个：ui-plugin-manager 内部是
        //    `rowConfigKey(pkg.name, row.rowId) = \`\${bundle}#\${rowId}\``，
        //    行的「配置」控件由 `configure.has(row) = ledger.rows.has(rowConfigKey(...))`
        //    决定 —— **键错一个字符就没有按钮**（PC 与移动端同一个 RowsSection，
        //    不存在"某端能进"的渲染差异）。
        //    本插件的 pkg.name = dsh-mimo-extension，行 id（cordis.patch.yml 的
        //    `- id:`）= dsh-mimo-extension（10-01 由短名改为全名）→ 键必须是
        //    `dsh-mimo-extension#dsh-mimo-extension`。曾误写短名副作用：
        //    has() 恒 false → 行配置页无入口（详情页跳转只能落到插件页根）。
        // view === 'summary' 给行卡片的摘要行；'page' 才是带保存按钮的表单。
        // 🔴 为什么必须**两个座都注册**（这是"进插件设置页还得再点一下组件"的根因）：
        //
        // 官方 `PackageDetail`（组合包详情页）渲染配置区的条件是
        //     `configured: ledger.bundles.has(openPkg.name)`
        // 而 `ledger.bundles` 只收集 **`plugins.bundle.config`** 座的 key
        // （`ledger.rows` 才收 `plugins.row.config`）。我们原先**只**注册
        // `plugins.row.config` → 打开插件详情页时 `configured === false` →
        // **配置区整块不渲染** → 必须再点进「包含的组件」里那一行才看得到表单。
        //
        // 官方范本（`dsh-experimental-client-ui-voice-input`）正是注册
        // `plugins.bundle.config` 且 `key` = **组合包名**：
        //     ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        //       name: "plugins.bundle.config",
        //       key: "@deepseek-ai/dsh-experimental-voice-input-bundle", … }))
        // 于是 `ledger.bundles.has("dsh-mimo-extension")` 成立 → 配置区直接出现。
        //
        // `plugins.row.config` **保留**：那是从「包含的组件」点进单行时的入口，
        // 去掉它那一行就没有配置入口了。两处渲染同一表单，互不冲突。
        // （同源修复见 dsh-usage-cyanmod 的 10-04 条目 ㉕。）
        const renderConfigForm = () => h(MimoSettingsForm, {});

        // ① 组合包座：让**插件详情页直接显示**配置区（`configured` 判据依赖它）。
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            { name: "plugins.bundle.config", key: PACKAGE_NAME, locale: NS },
            (slotProps) =>
              slotProps?.view === "summary"
                ? h(
                    "span",
                    { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                    t("view.title"),
                  )
                : renderConfigForm(),
          ),
        );

        // ② 行座：从「包含的组件」点进单行时的入口（保留，勿删）。
        ctx.slots.inject("plugins.row.config", () =>
          ctx.slots.register(
            {
              name: "plugins.row.config",
              key: `${PACKAGE_NAME}#${PACKAGE_NAME}`,
              locale: NS,
            },
            (slotProps) =>
              slotProps?.view === "summary"
                ? h(
                    "span",
                    { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #59636e)" } },
                    t("view.title"),
                  )
                : renderConfigForm(),
          ),
        );
        ctx.slots.inject("conversation.view", () => {
          disposeView = ctx.slots.register(
            {
              name: "conversation.view",
              id: "mimo-extension",
              order: 15,
              locale: NS,
              label: () => t("view.label"),
            },
            MimoUsageView,
          );
          return disposeView;
        });
        viewRegistered = true;
      };

      // ── 1b) 选中模型「探针」────────────────────────────────────────────
      //
      // apply 层拿不到 `useProjection`（那是**槽位组件的 hook**，在组件外调用会
      // 直接抛 React #321），所以用一个**不渲染任何像素**的探针组件挂在
      // `conversation.view` 里读投影，再经回调把结果交给 apply 层。
      //
      // ⚠ 探针必须挂在一个**始终存在**的座位上，否则一旦它自己被隐藏就断流。
      // 这里挂在 `conversation.input.right`（胶囊座位之一）—— 它只在用户把胶囊
      // 设为 hidden 时才不存在，而那种情况下详情页通常也不需要联动隐藏。

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
              id: "mimo-extension-pill",
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

      // 探针回传的选中模型 → 决定详情页 tab 是否挂出。
      // 首次拿到选择前**不动**（首帧 ensureView(true) 已注册），避免闪烁。
      let seenSelection = false;
      const applyTabVisibility = () => {
        // 偏好没开 → 永远显示
        if (uiPrefs.hideViewWhenNotMiMo !== true) {
          ensureView(true);
          return;
        }
        if (!seenSelection) {
          ensureView(true); // 还不知道选了什么 → 保守显示
          return;
        }
        ensureView(lastSelectionIsMiMo);
      };
      let lastSelectionIsMiMo = true;
      const onSelection = ({ provider, model }) => {
        seenSelection = true;
        // 与胶囊同一套判定：host 的地址级结论优先（summary.isMiMo），
        // provider 一致才采信；否则按名字（provider 名或 model 名）兜底。
        const hostSays = typeof latestSummary?.isMiMo === "boolean" ? latestSummary.isMiMo : undefined;
        const sameProvider = latestSummary?.provider && latestSummary.provider === (provider || undefined);
        const isMimo = hostSays !== undefined && sameProvider
          ? hostSays
          : isMiMoEntry(provider || undefined, model || undefined);
        if (isMimo === lastSelectionIsMiMo && seenSelection) {
          // 结果没变就不动注册（避免无谓的注销/重注册）
          return;
        }
        lastSelectionIsMiMo = isMimo;
        applyTabVisibility();
      };

      const ModelProbe = (props) => {
        const hit = (() => {
          try {
            if (typeof props?.useProjection !== "function") return null;
            const proj = props.useProjection("modelSelection");
            return proj?.next ?? proj?.lastUsed ?? null;
          } catch {
            return null;
          }
        })();
        const provider = typeof hit?.provider === "string" ? hit.provider : "";
        const model = typeof hit?.model === "string" ? hit.model : "";
        useEffect(() => {
          onSelection({ provider, model });
        }, [provider, model]);
        return null; // 不渲染任何东西
      };

      // 初始注册（默认 header），随后由偏好同步纠正
      ensureSeat(uiPrefs.position);
      // 详情页初始挂出（偏好可能还没拉到）
      ensureView(true);

      // 探针：挂在**始终存在**的 composer.dock 上（不占视觉空间，返回 null）。
      // 它是 apply 层获知"当前选中模型"的唯一途径 —— 见 ModelProbe 的说明。
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "mimo-extension-probe",
            order: 999,
            locale: NS,
            label: () => "",
          },
          ModelProbe,
        ),
      );
      const onPrefs = () => {
        ensureSeat(uiPrefs.position);
        applyTabVisibility(); // hideViewWhenNotMiMo 可能刚被改
      };
      uiPrefs.listeners.add(onPrefs);

      // 3) 工具栏换行：随偏好开/关
      let disposeWrap = applyToolbarWrap(uiPrefs.wrapToolbar);
      // 一直隐藏列宽拖拽手柄（本插件视图不需要；见 applyHideResizeHandles 注释）。
      // 它替代了 `data-conversation-composer-overlay` —— 那个会把视图锁成
      // 固定高度、导致详情页滚不动。
      const disposeHandles = applyHideResizeHandles(true);
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
          if (data) latestSummary = data;
          if (data?.ui) {
            setUiPrefs({
              position: data.ui.pillPosition ?? "header",
              wrapToolbar: data.ui.wrapToolbar !== false,
              hideViewWhenNotMiMo: data.ui.hideViewWhenNotMiMo === true,
            });
          }
          // 偏好（含 hideViewWhenNotMiMo）到手后重新评估一次 tab 可见性
          applyTabVisibility();
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
          try {
            disposeHandles();
          } catch {
            /* 忽略 */
          }
          try {
            disposeView?.();
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
        "dsh-mimo-extension: pill seats",
      );

      // 自诊断：注册完成，把结果报给宿主（/summary 的 client 字段可读）
      probe("applied", {
        entryName: String(entryName ?? ""),
        registered: ["conversation.view", PILL_SEATS[currentSeat]?.slot].filter(Boolean),
        pillPosition: String(currentSeat ?? ""),
      });
      console.info(
        `[dsh-mimo-extension] client 已装载：tab=MiMo 用量，pill=${currentSeat ?? "hidden"}`,
      );
    }

    const exports = {};
    // locale 必须与 slots 一起声明：apply 内会读取 ctx.locale，
    // 未声明的服务属性读取会被 Cordis 的上下文 Proxy 直接抛错。
    // timer：0.2.0 客户端定时器服务（未声明的 TIMER_VERBS 读取会被 ctx 代理拒绝）
    // layout：0.2 侧栏导航（selectPanel）——详情页「插件设置」跳转入口用
    // pluginNavigation：0.2 插件页的深链（openBundle，由 ui-plugin-manager
    //   经 ctx.reflect.provide 暴露）——让跳转直达本插件详情页而非插件页根
    //   （官方消费样例：dsh-experimental-client-ui-voice-input 同款 inject）
    exports.inject = ["slots", "locale", "timer", "layout", "pluginNavigation"];
    exports.apply = apply;
    return exports;
  }

    window.__ModuleLoader__.load({ id: "dsh-mimo-extension", factory: makeFactory });
    probe("module-loaded");
})();
