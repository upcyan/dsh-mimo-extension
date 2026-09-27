/**
 * dsh-mimo-usage 三项修复的端到端验证（不需要重启、不碰运行中的服务）。
 *
 * 用忠实模拟的 Cordis 上下文把 host.js 的 apply 跑起来，再直接调用
 * 注册出来的 /dsh-mimo-usage/* 路由，确认：
 *   1. token-usage 目录缺失 → local.ok=true，不再抛 ENOENT
 *   2. 官方 percent（0~1 比值）→ 0~100 百分数（与控制台同口径）
 *   3. tokenUsageCounter 缺席时 /session 仍返回真实 token 数（不再恒 null/0）
 *
 * 用法： node verify-fix.mjs
 */

import { readFileSync } from "node:fs";

const cookie = (() => {
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE.trim();
  try {
    const text = readFileSync(process.env.DSH_HOME + "/settings.yaml", "utf8");
    // settings.yaml 里 cookie 是带内嵌双引号的 YAML 标量，正则会截断 —— 只作兜底
    const m = /cookie:\s*(['"]?)(.+)\1\s*$/m.exec(text);
    return m ? m[2].trim() : "";
  } catch {
    return "";
  }
})();

const host = await import("./host.js");

// ---------- 会话事件（与 session.v3.jsonl.zstd 里真实结构一致） ----------
const now = Date.now();
const events = [
  { type: "request/header", seq: 10, time: now, data: { header: { config: { provider: "mimo", model: "mimo-v2.6-flash" } } } },
  {
    type: "assistant/message",
    seq: 15,
    time: now,
    data: { usage: { inputTokens: 157, outputTokens: 74, totalTokens: 8295, cacheReadTokens: 8064 } },
  },
  {
    type: "step/end",
    seq: 20,
    time: now,
    data: { turn: 1, step: 1 },
  },
  {
    type: "assistant/message",
    seq: 25,
    time: now,
    data: {
      message: { source: { provider: "mimo", model: "mimo-v2.6-flash" } },
      usage: { inputTokens: 200, outputTokens: 90, totalTokens: 9200, cacheReadTokens: 8910 },
    },
  },
];
const SESSION_ID = "verify-session";
const session = { id: SESSION_ID, snapshotEvents: () => events };
const sessionsSvc = { list: () => [session], get: (id) => (id === SESSION_ID ? session : undefined) };

// ---------- 模拟 Cordis 上下文 ----------
const routes = [];
const tools = [];
const commands = [];
// 模拟 llm-pi-ai 命名空间的解析结果：provider 的 baseURL 从这里读
//（与现网 settings.yaml 一致：mimo → token-plan 网关）
const llmPiAiDoc = {
  providers: {
    mimo: { displayName: "mimo", api: "openai-completions", baseURL: "https://token-plan-cn.xiaomimimo.com/v1" },
  },
};
const makeScope = (extra = {}) => ({
  settings: {
    register: (ns) => ({ get: () => ({}), update: async () => {}, watch: () => {} }),
    get: (ns) => (ns === "llm-pi-ai" ? llmPiAiDoc : undefined),
  },
  webServer: { register: (def) => routes.push(def) },
  commands: { register: (c) => commands.push(c) },
  tools: { register: (t) => tools.push(t) },
  effect: (fn) => fn(),
  ...extra,
});

const ctx = {
  get: (name) => (name === "sessions" ? sessionsSvc : undefined),
  on: () => () => {},
  inject: (names, cb) => cb(makeScope()),
  logger: { warn: (...a) => console.error("[warn]", ...a), info: () => {}, error: (...a) => console.error("[err]", ...a) },
  baseUrl: undefined,
};

host.apply(ctx, { mimo: { cookie, planTotalTokens: 500_000_000 } });

const route = routes.find((r) => r.path === "/dsh-mimo-usage");
if (!route) {
  console.error("✗ 没拿到 /dsh-mimo-usage 路由");
  process.exit(1);
}

const call = async (target) => {
  const req = { url: target, method: "GET", headers: { host: "localhost" } };
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s) => (status = s),
    end: (b) => (body = b),
    setHeader: () => {},
  };
  await route.handler(req, res);
  return { status, json: JSON.parse(body || "{}") };
};

// POST 版（自诊断 /ping 回传）
const postJson = async (target, payload) => {
  const raw = JSON.stringify(payload ?? {});
  const req = {
    url: target,
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    setEncoding: () => {},
    on: (event, cb) => {
      if (event === "data") cb(raw);
      else if (event === "end") cb();
    },
  };
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s) => (status = s),
    end: (b) => (body = b),
    setHeader: () => {},
  };
  await route.handler(req, res);
  return { status, json: JSON.parse(body || "{}") };
};

const fail = [];
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fail.push(msg);
};

// ---------- 1) summary ----------
const s = await call("/dsh-mimo-usage/summary?refresh=1");
const d = s.json?.data ?? {};
ok(s.status === 200 && s.json.ok, "GET /summary → 200");
ok(d.official === true, `官方接口可用（official=${d.official}${d.officialError ? `, error=${d.officialError}` : ""}）`);

if (d.official && d.planUsage) {
  const item = d.planUsage.items?.[0] ?? {};
  const rawRatio = Number(item.used) / Number(item.limit);
  ok(
    item.percent > 1 || item.percent === 0,
    `本月已用按 0~100 显示：${item.percent}%（used/limit=${(rawRatio * 100).toFixed(3)}%）`,
  );
  ok(
    Math.abs(item.percent - rawRatio * 100) < 0.15,
    `与 used/limit 口径一致（差 ${Math.abs(item.percent - rawRatio * 100).toFixed(4)} 个百分点）`,
  );
  ok(d.planUsage.unit === "Credits", `单位为 Credits（实为 ${d.planUsage.unit}）`);
  ok(Math.abs(d.planUsage.percent - item.percent) < 1e-6, "顶层 percent 与 items[0] 一致");
}

ok(d.local && d.local.ok === true, `本地统计不再报错（ok=${d.local?.ok}, error=${d.local?.error || "无"}）`);
ok(!String(d.local?.error ?? "").includes("ENOENT"), "local.error 不含 ENOENT");
ok(typeof d.local?.monthTokens === "number", `本月 tokens 有值（${d.local?.monthTokens}）`);
ok(typeof d.local?.todayTokens === "number", `今日 tokens 有值（${d.local?.todayTokens}）`);
ok(d.local?.source === "session-events", `本地统计来源标注为 ${d.local?.source}`);

// ---------- 2) 计费类型：读 provider 的 API 地址判定 ----------
ok(d.provider === "mimo", `当前 provider = ${d.provider || "（无）"}`);
ok(d.planStatus === "active", `官方套餐状态 = ${d.planStatus}（期望 active）`);
ok(d.providerBaseURL === "https://token-plan-cn.xiaomimimo.com/v1",
  `从 llm-pi-ai 读到 baseURL = ${d.providerBaseURL}`);
ok(d.billingType === "token-plan", `计费类型 = ${d.billingType}（期望 token-plan，此前恒为 payg）`);

// 反证：同一 provider 把地址换成按量网关 → 计费类型必须跟着变（地址决定类型）
llmPiAiDoc.providers.mimo.baseURL = "https://api.xiaomimimo.com/v1";
const paygRun = await call("/dsh-mimo-usage/summary?refresh=1");
ok(
  paygRun.json?.data?.billingType === "payg" &&
    paygRun.json?.data?.providerBaseURL === "https://api.xiaomimimo.com/v1",
  `地址换成 api.xiaomimimo.com → billingType=${paygRun.json?.data?.billingType}（期望 payg）`,
);
llmPiAiDoc.providers.mimo.baseURL = "https://token-plan-cn.xiaomimimo.com/v1";
const backRun = await call("/dsh-mimo-usage/summary?refresh=1");
ok(backRun.json?.data?.billingType === "token-plan",
  `地址改回 token-plan 网关 → billingType=${backRun.json?.data?.billingType}（期望 token-plan）`);

// ---------- 3) session ----------
const sess = await call(`/dsh-mimo-usage/session?id=${SESSION_ID}`);
const sd = sess.json?.data ?? null;
const expected = events.reduce(
  (n, e) => n + (e.data?.usage ? e.data.usage.inputTokens + e.data.usage.outputTokens + e.data.usage.cacheReadTokens : 0),
  0,
);
ok(sd !== null, "GET /session 返回数据（此前恒为 null → 会话用量恒 0）");
ok(sd?.totalTokens === expected, `会话 totalTokens = ${expected}（实得 ${sd?.totalTokens}）`);
ok(sd?.calls === 2, `会话 calls = 2（实得 ${sd?.calls}）`);
ok(sd?.source === "session-events", `会话数据来源 = ${sd?.source}`);
ok(Number(d.sessionTokens) > 0 || Number(sd?.totalTokens) > 0, "会话 token 使用量不再恒为 0");

// 重复调用：seq 去重，数值不得翻倍
const sess2 = await call(`/dsh-mimo-usage/session?id=${SESSION_ID}`);
ok(sess2.json?.data?.totalTokens === expected, `重复请求不翻倍（${sess2.json?.data?.totalTokens}）`);

// 未知会话
const unknown = await call("/dsh-mimo-usage/session?id=nope");
ok(unknown.json?.data === null, "未知会话返回 null（不抛错）");

// ---------- 4) /mimo 命令文本 ----------
const cmd = commands.find((c) => c.name === "mimo");
const out = await cmd.handler({ signal: undefined });
ok(out?.kind === "success", "斜杠命令 /mimo 可执行");
ok(/计费类型：Token Plan 套餐/.test(out?.text ?? ""), "/mimo 文本判定为 Token Plan 套餐");
ok(/本月已用 \d+(\.\d+)?%/.test(out?.text ?? ""), "/mimo 文本给出本月已用百分比");
console.log("\n--- /mimo 输出 ---\n" + out.text + "\n");

// ---------- 5) 浏览器半边自诊断回传（/ping → /summary.client） ----------
// "装了没生效"只发生在浏览器里；client 在 module-loaded → factory →
// apply-entered → applied 各节点报到，服务端就能读出它卡在哪一步。
const ping = await postJson("/dsh-mimo-usage/ping", {
  stage: "applied",
  entryName: "dsh-mimo-usage",
  registered: ["conversation.view", "conversation.input.right"],
  path: "/",
});
ok(ping.status === 200 && ping.json?.ok === true, `POST /ping → ${ping.status}`);
const afterPing = await call("/dsh-mimo-usage/summary");
ok(afterPing.json?.data?.client?.stage === "applied",
  `GET /summary.client.stage = ${afterPing.json?.data?.client?.stage}（期望 applied）`);
ok(Array.isArray(afterPing.json?.data?.client?.registered) &&
    afterPing.json?.data?.client?.registered.includes("conversation.view"),
  "client.registered 回传了已注册槽位");
ok(typeof afterPing.json?.data?.client?.at === "number", "client.at 是时间戳（不随 summary 缓存过期）");
ok(Array.isArray(afterPing.json?.data?.clientLog) && afterPing.json?.data?.clientLog.length >= 1,
  `clientLog 累积 ${afterPing.json?.data?.clientLog?.length ?? 0} 条（带页面路径与时序）`);
ok(afterPing.json?.data?.client?.path === "/", `回传带页面路径（path=${afterPing.json?.data?.client?.path}）`);
const badPing = await postJson("/dsh-mimo-usage/ping", "not-an-object");
ok(badPing.status === 400, `非对象请求体 → 400（实为 ${badPing.status}）`);
const getPing = await call("/dsh-mimo-usage/ping");
ok(getPing.status === 405, `GET /ping → 405（实为 ${getPing.status}）`);

if (fail.length) {
  console.log(`\n>>> ${fail.length} 项未通过`);
  process.exit(1);
}
console.log(">>> 端到端验证全部通过");
