import {
  cleanMessage,
  escapeHtml,
  json,
  mapUrls,
  maskPhone,
  normalizeLocation,
  phoneForTel,
  publicBaseUrl,
  randomToken,
  sha256,
} from "./lib.js";

const API_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (!countryAllowed(request, env)) {
        return apiError("当前地区暂不可用", 403);
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        return json(
          {
            ownerName: env.PUBLIC_OWNER_NAME || "车主",
            carLabel: env.PUBLIC_CAR_LABEL || "这辆车",
            notice: env.PUBLIC_NOTICE || "感谢理解，我会尽快赶来",
            turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
            pushConfigured: Boolean(env.PUSHPLUS_TOKEN),
            phoneConfigured: Boolean(phoneForTel(env.PHONE_NUMBER)),
          },
          { headers: API_HEADERS },
        );
      }

      if (url.pathname === "/api/request" && request.method === "POST") {
        return handleMoveRequest(request, env, ctx);
      }

      const match = url.pathname.match(
        /^\/api\/session\/([0-9a-f]{64})\/(status|phone|confirm|expedite|cancel)$/,
      );
      if (match) {
        const [, sessionId, action] = match;
        if (action === "status" && request.method === "GET") {
          return handleStatus(request, env, sessionId);
        }
        if (action === "phone" && request.method === "GET") {
          return handlePhone(request, env, sessionId);
        }
        if (action === "confirm" && request.method === "POST") {
          return handleConfirm(request, env, sessionId);
        }
        if (action === "expedite" && request.method === "POST") {
          return handleExpedite(request, env, sessionId);
        }
        if (action === "cancel" && request.method === "POST") {
          return handleCancel(request, env, sessionId);
        }
      }

      return apiError("接口不存在", 404);
    } catch (error) {
      console.error("Unhandled API error", error);
      return apiError("服务暂时不可用，请稍后再试", 500);
    }
  },
};

async function handleMoveRequest(request, env, ctx) {
  if (!isSameOriginMutation(request)) return apiError("请求来源无效", 403);
  if (!env.PUSHPLUS_TOKEN) {
    console.error("MoveCar request rejected because PushPlus is not configured");
    return apiError("车主尚未完成微信通知配置，请改用其他联系方式", 503, "PUSH_NOT_CONFIGURED");
  }
  const body = await readJsonBody(request);
  if (!body) return apiError("请求内容无效", 400);

  const turnstile = await verifyTurnstile(request, env, body.turnstileToken);
  if (!turnstile.ok) return apiError(turnstile.message, 403, "TURNSTILE_FAILED");

  const message = cleanMessage(body.message);
  const requesterLocation = normalizeLocation(body.location);
  const now = Date.now();
  const cooldownSeconds = boundedInteger(env.REQUEST_COOLDOWN_SECONDS, 90, 10, 900);
  const abuseKey = await requestFingerprint(request);
  const limiter = env.MOVECAR_SESSION.getByName(`rate:${abuseKey}`);
  const rateResponse = await limiter.fetch("https://session.internal/rate/check", {
    method: "POST",
    body: JSON.stringify({ now, cooldownSeconds }),
  });
  const rate = await rateResponse.json();
  if (!rate.allowed) {
    return json(
      {
        ok: false,
        error: `呼叫太频繁，请 ${rate.retryAfter} 秒后再试`,
        code: "RATE_LIMITED",
        retryAfter: rate.retryAfter,
      },
      {
        status: 429,
        headers: { ...API_HEADERS, "retry-after": String(rate.retryAfter) },
      },
    );
  }

  const callerToken = randomToken();
  const ownerToken = randomToken();
  const ttlSeconds = boundedInteger(env.SESSION_TTL_SECONDS, 3600, 300, 86400);
  const sessionObjectId = env.MOVECAR_SESSION.newUniqueId();
  const sessionId = sessionObjectId.toString();
  const session = env.MOVECAR_SESSION.get(sessionObjectId);
  const baseUrl = publicBaseUrl(request.url, env.PUBLIC_BASE_URL);
  const delaySeconds = requesterLocation
    ? 0
    : boundedInteger(env.DELAY_WITHOUT_LOCATION_SECONDS, 30, 5, 120);
  const notifyAt = now + delaySeconds * 1000;

  const createResponse = await session.fetch("https://session.internal/session/create", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      message,
      requesterLocation,
      ownerToken,
      baseUrl,
      notifyAt,
      delayed: delaySeconds > 0,
      callerTokenHash: await sha256(callerToken),
      ownerTokenHash: await sha256(ownerToken),
    }),
  });
  if (!createResponse.ok) {
    ctx.waitUntil(
      limiter.fetch("https://session.internal/rate/release", {
        method: "POST",
        body: JSON.stringify({ createdAt: now }),
      }),
    );
    return apiError("无法创建本次呼叫，请稍后重试", 503, "SESSION_CREATE_FAILED");
  }

  return json(
    {
      ok: true,
      sessionId,
      callerToken,
      expiresAt: now + ttlSeconds * 1000,
      status: "scheduled",
      notifyAt,
      delaySeconds,
      phoneAvailable: Boolean(phoneForTel(env.PHONE_NUMBER)),
    },
    { status: 202, headers: API_HEADERS },
  );
}

async function handleStatus(request, env, sessionId) {
  const token = bearerToken(request);
  if (!token) return apiError("缺少访问凭证", 401);
  const session = sessionStub(env, sessionId);
  if (!session) return apiError("会话编号无效", 404);
  const response = await session.fetch("https://session.internal/session/status", {
    method: "POST",
    body: JSON.stringify({ tokenHash: await sha256(token) }),
  });
  return proxyJson(response);
}

async function handlePhone(request, env, sessionId) {
  const token = bearerToken(request);
  if (!token) return apiError("缺少访问凭证", 401);
  const phone = phoneForTel(env.PHONE_NUMBER);
  if (!phone) return apiError("车主未配置备用电话", 404, "PHONE_UNAVAILABLE");

  const session = sessionStub(env, sessionId);
  if (!session) return apiError("会话编号无效", 404);
  const response = await session.fetch("https://session.internal/session/phone-authorize", {
    method: "POST",
    body: JSON.stringify({ tokenHash: await sha256(token) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    return json(result, { status: response.status, headers: API_HEADERS });
  }
  return json(
    { ok: true, phone, maskedPhone: maskPhone(phone), tel: `tel:${phone}` },
    { headers: API_HEADERS },
  );
}

async function handleConfirm(request, env, sessionId) {
  if (!isSameOriginMutation(request)) return apiError("请求来源无效", 403);
  const token = bearerToken(request);
  if (!token) return apiError("缺少访问凭证", 401);
  const body = await readJsonBody(request);
  if (!body) return apiError("请求内容无效", 400);

  const ownerReply = cleanMessage(body.reply || "已收到，我正在赶来").slice(0, 40);
  const ownerLocation = normalizeLocation(body.location);
  const session = sessionStub(env, sessionId);
  if (!session) return apiError("会话编号无效", 404);
  const response = await session.fetch("https://session.internal/session/confirm", {
    method: "POST",
    body: JSON.stringify({
      tokenHash: await sha256(token),
      ownerReply,
      ownerLocation,
      confirmedAt: Date.now(),
    }),
  });
  return proxyJson(response);
}

async function handleExpedite(request, env, sessionId) {
  if (!isSameOriginMutation(request)) return apiError("请求来源无效", 403);
  const token = bearerToken(request);
  if (!token) return apiError("缺少访问凭证", 401);
  const body = await readJsonBody(request);
  const location = normalizeLocation(body?.location);
  if (!location) return apiError("需要有效位置才能立即通知", 400, "LOCATION_REQUIRED");

  const session = sessionStub(env, sessionId);
  if (!session) return apiError("会话编号无效", 404);
  const response = await session.fetch("https://session.internal/session/expedite", {
    method: "POST",
    body: JSON.stringify({ tokenHash: await sha256(token), location }),
  });
  return proxyJson(response);
}

async function handleCancel(request, env, sessionId) {
  if (!isSameOriginMutation(request)) return apiError("请求来源无效", 403);
  const token = bearerToken(request);
  if (!token) return apiError("缺少访问凭证", 401);
  const session = sessionStub(env, sessionId);
  if (!session) return apiError("会话编号无效", 404);
  const response = await session.fetch("https://session.internal/session/cancel", {
    method: "POST",
    body: JSON.stringify({ tokenHash: await sha256(token) }),
  });
  return proxyJson(response);
}

async function sendPushPlus(env, data) {
  if (!env.PUSHPLUS_TOKEN) return { ok: false, reason: "PUSHPLUS_TOKEN is missing" };
  const maps = mapUrls(data.location, "呼叫者位置");
  const ownerFragment = new URLSearchParams({
    session: data.sessionId,
    token: data.ownerToken,
  }).toString();
  const ownerUrl = `${data.baseUrl}/owner.html#${ownerFragment}`;
  const locationHtml = maps
    ? `<p><strong>位置：</strong><a href="${escapeHtml(maps.amap)}">高德地图</a> · <a href="${escapeHtml(maps.apple)}">Apple 地图</a></p>`
    : "<p><strong>位置：</strong>呼叫者未共享位置</p>";
  const content = [
    "<h2>🚗 有人请求挪车</h2>",
    `<p><strong>留言：</strong>${escapeHtml(data.message)}</p>`,
    locationHtml,
    `<p><a href="${escapeHtml(ownerUrl)}" style="display:inline-block;padding:12px 18px;background:#176b87;color:#fff;text-decoration:none;border-radius:10px">查看并回复</a></p>`,
    "<p style=\"color:#718096\">链接一小时内有效，请勿转发。</p>",
  ].join("");

  try {
    const response = await fetch(env.PUSHPLUS_ENDPOINT || "https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        token: env.PUSHPLUS_TOKEN,
        title: "🚗 有人呼叫挪车",
        content,
        template: "html",
        channel: "wechat",
      }),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const result = await response.json().catch(() => null);
    if (!result || Number(result.code) !== 200) {
      const reason = result?.msg || "Invalid PushPlus response";
      console.error("PushPlus rejected notification", {
        code: result?.code ?? null,
        reason,
      });
      return { ok: false, reason };
    }
    console.log("PushPlus accepted notification", {
      receipt: result.data ?? null,
    });
    return { ok: true, receipt: result.data ?? null };
  } catch (error) {
    console.error("PushPlus request failed", { reason: error.message });
    return { ok: false, reason: error.message };
  }
}

async function verifyTurnstile(request, env, token) {
  const configured = Boolean(env.TURNSTILE_SITE_KEY || env.TURNSTILE_SECRET_KEY);
  if (!configured) return { ok: true };
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
    return { ok: false, message: "人机验证配置不完整" };
  }
  if (!token) return { ok: false, message: "请先完成人机验证" };

  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", String(token));
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form, signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok) return { ok: false, message: "人机验证服务暂不可用" };
  const result = await response.json();
  return result.success
    ? { ok: true }
    : { ok: false, message: "人机验证未通过，请刷新后重试" };
}

function countryAllowed(request, env) {
  if (!env.ALLOWED_COUNTRIES) return true;
  const country = request.cf?.country;
  if (!country) return env.ENVIRONMENT !== "production";
  const allowed = new Set(
    String(env.ALLOWED_COUNTRIES)
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
  return allowed.has(country.toUpperCase());
}

function isSameOriginMutation(request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  const marker = request.headers.get("x-movecar-client");
  return marker === "web" || !fetchSite;
}

async function requestFingerprint(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local";
  const network = request.cf?.asn ? `${request.cf.asn}` : "unknown";
  return (await sha256(`${ip}|${network}`)).slice(0, 32);
}

async function readJsonBody(request) {
  const contentType = request.headers.get("content-type") || "";
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!contentType.includes("application/json") || contentLength > 4096) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel("request body too large");
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function sessionStub(env, sessionId) {
  try {
    return env.MOVECAR_SESSION.get(env.MOVECAR_SESSION.idFromString(sessionId));
  } catch {
    return null;
  }
}

function bearerToken(request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  return match?.[1] || null;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function apiError(error, status, code = "REQUEST_FAILED") {
  return json({ ok: false, error, code }, { status, headers: API_HEADERS });
}

async function proxyJson(response) {
  const body = await response.json().catch(() => ({ ok: false, error: "会话响应无效" }));
  return json(body, { status: response.status, headers: API_HEADERS });
}

export class MoveCarSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (url.pathname === "/rate/check") {
      const previous = await this.state.storage.get("lastRequestAt");
      const cooldownMs = Number(body.cooldownSeconds || 90) * 1000;
      if (previous && body.now - previous < cooldownMs) {
        const retryAfter = Math.max(1, Math.ceil((previous + cooldownMs - body.now) / 1000));
        return json({ allowed: false, retryAfter });
      }
      await this.state.storage.put("lastRequestAt", body.now);
      await this.state.storage.setAlarm(body.now + cooldownMs + 60000);
      return json({ allowed: true });
    }

    if (url.pathname === "/rate/release") {
      const previous = await this.state.storage.get("lastRequestAt");
      if (previous === body.createdAt) {
        await this.state.storage.delete("lastRequestAt");
        await this.state.storage.deleteAlarm();
      }
      return json({ ok: true });
    }

    if (url.pathname === "/session/create") {
      const existing = await this.state.storage.get("session");
      if (existing) return json({ ok: false, error: "会话已存在" }, { status: 409 });
      const session = {
        ...body,
        status: "scheduled",
        pushSentAt: null,
        confirmedAt: null,
        ownerReply: null,
        ownerLocation: null,
        retryCount: 0,
      };
      await this.state.storage.put("session", session);
      await this.state.storage.setAlarm(body.notifyAt);
      return json({ ok: true });
    }

    const session = await this.state.storage.get("session");
    if (!session || Date.now() >= session.expiresAt) {
      return json({ ok: false, error: "本次呼叫已过期", code: "SESSION_EXPIRED" }, { status: 410 });
    }

    const role =
      body.tokenHash === session.callerTokenHash
        ? "caller"
        : body.tokenHash === session.ownerTokenHash
          ? "owner"
          : null;
    if (!role) return json({ ok: false, error: "访问凭证无效" }, { status: 403 });

    if (url.pathname === "/session/status") {
      const common = {
        ok: true,
        role,
        status: session.status,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        confirmedAt: session.confirmedAt,
        notifyAt: session.notifyAt,
      };
      if (role === "owner") {
        return json({
          ...common,
          message: session.message,
          requesterLocation: session.requesterLocation,
          requesterMaps: mapUrls(session.requesterLocation, "呼叫者位置"),
        });
      }
      return json({
        ...common,
        ownerReply: session.ownerReply,
        ownerLocation: session.ownerLocation,
        ownerMaps: mapUrls(session.ownerLocation, "车主位置"),
      });
    }

    if (url.pathname === "/session/phone-authorize") {
      if (role !== "caller") return json({ ok: false, error: "无权查看电话" }, { status: 403 });
      if (!["accepted", "confirmed"].includes(session.status)) {
        return json({ ok: false, error: "通知尚未被推送服务受理" }, { status: 409 });
      }
      return json({ ok: true });
    }

    if (url.pathname === "/session/expedite") {
      if (role !== "caller") return json({ ok: false, error: "无权操作本次呼叫" }, { status: 403 });
      if (!["scheduled", "push_failed"].includes(session.status)) {
        return json({ ok: false, error: "通知已经发送或正在发送" }, { status: 409 });
      }
      session.requesterLocation = body.location;
      session.notifyAt = Date.now();
      session.status = "scheduled";
      await this.state.storage.put("session", session);
      await this.state.storage.setAlarm(session.notifyAt);
      return json({ ok: true, status: session.status, notifyAt: session.notifyAt });
    }

    if (url.pathname === "/session/cancel") {
      if (role !== "caller") return json({ ok: false, error: "无权取消本次呼叫" }, { status: 403 });
      if (session.status !== "scheduled") {
        return json({ ok: false, error: "通知已发送，无法取消" }, { status: 409 });
      }
      session.status = "cancelled";
      session.cancelledAt = Date.now();
      session.ownerToken = null;
      await this.state.storage.put("session", session);
      await this.state.storage.setAlarm(session.expiresAt);
      return json({ ok: true, status: session.status });
    }

    if (url.pathname === "/session/confirm") {
      if (role !== "owner") return json({ ok: false, error: "无权确认本次呼叫" }, { status: 403 });
      if (!["accepted", "confirmed"].includes(session.status)) {
        return json({ ok: false, error: "当前呼叫尚不可确认" }, { status: 409 });
      }
      session.status = "confirmed";
      session.confirmedAt = body.confirmedAt;
      session.ownerReply = body.ownerReply;
      session.ownerLocation = body.ownerLocation;
      await this.state.storage.put("session", session);
      return json({ ok: true, status: session.status });
    }

    return json({ ok: false, error: "内部接口不存在" }, { status: 404 });
  }

  async alarm() {
    const session = await this.state.storage.get("session");
    if (!session) {
      const rateTimestamp = await this.state.storage.get("lastRequestAt");
      if (rateTimestamp) await this.state.storage.deleteAll();
      return;
    }
    if (Date.now() >= session.expiresAt) {
      await this.state.storage.deleteAll();
      return;
    }
    if (session.status === "scheduled") {
      if (Date.now() < session.notifyAt) {
        await this.state.storage.setAlarm(session.notifyAt);
        return;
      }
      await this.deliverNotification(session);
      return;
    }
    if (session.status === "sending") {
      if (Date.now() < session.watchdogAt) {
        await this.state.storage.setAlarm(session.watchdogAt);
        return;
      }
      session.status = "push_failed";
      session.lastError = "发送状态不确定，为避免重复提醒已停止重试";
      session.attemptId = null;
      await this.state.storage.put("session", session);
    }
    await this.state.storage.setAlarm(session.expiresAt);
  }

  async deliverNotification(session) {
    if (!["scheduled", "push_failed"].includes(session.status)) {
      return json({ ok: false, error: "通知已处理", status: session.status }, { status: 409 });
    }
    const attemptId = crypto.randomUUID();
    session.status = "sending";
    session.attemptId = attemptId;
    session.watchdogAt = Math.min(session.expiresAt, Date.now() + 12000);
    await this.state.storage.put("session", session);
    await this.state.storage.setAlarm(session.watchdogAt);
    let result;
    try {
      result = await sendPushPlus(this.env, {
        sessionId: session.sessionId,
        ownerToken: session.ownerToken,
        message: session.message,
        location: session.requesterLocation,
        baseUrl: session.baseUrl,
        createdAt: session.createdAt,
      });
    } catch (error) {
      result = { ok: false, reason: error.message };
    }
    const current = await this.state.storage.get("session");
    if (
      !current ||
      current.attemptId !== attemptId ||
      current.status !== "sending" ||
      Date.now() >= current.watchdogAt ||
      Date.now() >= current.expiresAt
    ) {
      return json({ ok: false, error: "会话已变化或过期" }, { status: 409 });
    }
    if (result.ok) {
      current.status = "accepted";
      current.pushSentAt = Date.now();
      current.pushReceipt = result.receipt;
      current.ownerToken = null;
      current.attemptId = null;
      await this.state.storage.put("session", current);
      await this.state.storage.setAlarm(current.expiresAt);
      return json({ ok: true, status: current.status });
    }

    console.error("MoveCar notification delivery failed", {
      sessionId: current.sessionId,
      retryCount: Number(current.retryCount || 0) + 1,
      reason: result.reason,
    });
    current.retryCount = Number(current.retryCount || 0) + 1;
    current.attemptId = null;
    const nextRetryAt = Date.now() + current.retryCount * 15000;
    if (current.retryCount <= 2 && nextRetryAt < current.expiresAt) {
      current.status = "scheduled";
      current.notifyAt = nextRetryAt;
      await this.state.storage.put("session", current);
      await this.state.storage.setAlarm(current.notifyAt);
    } else {
      current.status = "push_failed";
      await this.state.storage.put("session", current);
      await this.state.storage.setAlarm(current.expiresAt);
    }
    return json(
      { ok: false, error: "通知发送失败", reason: result.reason, status: current.status },
      { status: 502 },
    );
  }
}
