const state = {
  config: null,
  location: null,
  locationEnabled: false,
  turnstileToken: null,
  session: null,
  pollTimer: null,
  pollDelay: 2500,
  countdownTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const requestView = $("#requestView");
const waitingView = $("#waitingView");
const form = $("#requestForm");
const message = $("#message");
const messageCount = $("#messageCount");
const locationButton = $("#locationButton");
const submitButton = $("#submitButton");
const formError = $("#formError");

init();

async function init() {
  bindEvents();
  restoreSession();
  try {
    const response = await fetch("/api/config", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("配置读取失败");
    state.config = await response.json();
    $("#carIntro").textContent = `${state.config.carLabel}的${state.config.ownerName}会收到提醒；未共享位置时有 30 秒安全等待，电话号码不会公开展示。`;
    if (state.config.turnstileSiteKey) mountTurnstile(state.config.turnstileSiteKey);
  } catch {
    showError("网络连接不稳定，请刷新页面重试");
  }
}

function bindEvents() {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((item) => item.classList.remove("active"));
      chip.classList.add("active");
      message.value = chip.dataset.message;
      updateMessageCount();
    });
  });
  message.addEventListener("input", () => {
    document.querySelectorAll(".chip").forEach((item) => item.classList.remove("active"));
    updateMessageCount();
  });
  locationButton.addEventListener("click", toggleLocation);
  form.addEventListener("submit", submitRequest);
  $("#phoneButton").addEventListener("click", revealPhone);
  $("#sendNowButton").addEventListener("click", expediteWithLocation);
  $("#cancelButton").addEventListener("click", cancelRequest);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.session) schedulePoll(100);
  });
}

function updateMessageCount() {
  messageCount.textContent = `${message.value.length} / 80`;
}

async function toggleLocation() {
  if (state.locationEnabled) {
    state.locationEnabled = false;
    state.location = null;
    setLocationUi(false, "附上我所在的位置", "可选；不共享位置时将等待 30 秒发送");
    return;
  }
  if (!navigator.geolocation) {
    toast("当前浏览器不支持定位");
    return;
  }
  locationButton.disabled = true;
  setLocationUi(false, "正在获取位置…", "请在浏览器提示中允许定位");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.locationEnabled = true;
      state.location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      locationButton.disabled = false;
      setLocationUi(true, "位置已附上", `定位精度约 ${Math.round(position.coords.accuracy)} 米 · 点击取消`);
    },
    (error) => {
      locationButton.disabled = false;
      const text = error.code === 1 ? "未获得定位权限，仍可直接通知" : "定位失败，仍可直接通知";
      setLocationUi(false, "附上我所在的位置", text);
      toast(text);
    },
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 },
  );
}

function setLocationUi(selected, title, hint) {
  locationButton.classList.toggle("selected", selected);
  locationButton.setAttribute("aria-pressed", String(selected));
  $("#locationTitle").textContent = title;
  $("#locationHint").textContent = hint;
}

async function submitRequest(event) {
  event.preventDefault();
  hideError();
  if (state.config?.turnstileSiteKey && !state.turnstileToken) {
    showError("请先完成人机验证");
    return;
  }
  setSubmitting(true);
  try {
    const response = await fetch("/api/request", {
      method: "POST",
      headers: { "content-type": "application/json", "x-movecar-client": "web" },
      body: JSON.stringify({
        message: message.value,
        location: state.locationEnabled ? state.location : null,
        turnstileToken: state.turnstileToken,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "通知发送失败");
    state.session = {
      id: result.sessionId,
      token: result.callerToken,
      expiresAt: result.expiresAt,
      status: result.status,
      notifyAt: result.notifyAt,
      phoneAvailable: result.phoneAvailable,
    };
    sessionStorage.setItem("movecar-session", JSON.stringify(state.session));
    showWaiting();
  } catch (error) {
    showError(error.message);
    resetTurnstile();
  } finally {
    setSubmitting(false);
  }
}

function setSubmitting(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector("span").textContent = loading ? "正在通知车主…" : "通知车主";
}

function restoreSession() {
  try {
    const restored = JSON.parse(sessionStorage.getItem("movecar-session"));
    if (restored?.id && restored?.token && restored.expiresAt > Date.now()) {
      state.session = restored;
      showWaiting();
    } else {
      sessionStorage.removeItem("movecar-session");
    }
  } catch {
    sessionStorage.removeItem("movecar-session");
  }
}

function showWaiting() {
  requestView.hidden = true;
  waitingView.hidden = false;
  renderSessionState(state.session.status);
  updateExpiry();
  state.pollDelay = 2500;
  schedulePoll(300);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function schedulePoll(delay = state.pollDelay) {
  clearTimeout(state.pollTimer);
  if (!state.session || document.hidden) return;
  state.pollTimer = setTimeout(checkStatus, delay);
}

async function checkStatus() {
  if (!state.session) return;
  try {
    const response = await sessionFetch("status");
    const result = await response.json();
    if ([401, 403, 404, 410].includes(response.status)) {
      expireSession(result.error);
      return;
    }
    if (!response.ok) throw new Error(result.error || "状态查询失败");
    state.session.status = result.status;
    state.session.notifyAt = result.notifyAt;
    sessionStorage.setItem("movecar-session", JSON.stringify(state.session));
    if (result.status === "confirmed") {
      renderConfirmed(result);
      return;
    }
    renderSessionState(result.status, result);
    if (["push_failed", "cancelled"].includes(result.status)) {
      return;
    }
    if (result.status === "scheduled") {
      state.pollDelay = Math.min(1000, Math.max(250, result.notifyAt - Date.now()));
    } else if (result.status === "sending") {
      state.pollDelay = 1000;
    } else {
      state.pollDelay = Math.min(12000, Math.round(state.pollDelay * 1.3));
    }
    schedulePoll();
  } catch {
    state.pollDelay = Math.min(15000, state.pollDelay + 3000);
    schedulePoll();
  }
}

function renderConfirmed(result) {
  clearTimeout(state.pollTimer);
  clearInterval(state.countdownTimer);
  $("#delayPanel").hidden = true;
  $("#resultIcon").classList.remove("waiting");
  $("#resultIcon").classList.add("confirmed");
  $("#resultIcon").innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6" /></svg>';
  $("#resultEyebrow").textContent = "车主已回复";
  $("#resultTitle").textContent = "车主正在处理";
  $("#resultText").textContent = "感谢耐心等待，请留意车辆周边情况。";
  $("#notifiedStep").classList.add("done");
  document.querySelectorAll(".progress-line")[0].classList.add("active");
  $("#confirmedLine").classList.add("active");
  $("#confirmedStep").classList.add("done");
  $("#phoneButton").hidden = state.session.phoneAvailable === false;
  $("#ownerReply").hidden = false;
  $("#ownerReplyText").textContent = result.ownerReply || "已收到，我正在赶来";
  if (result.ownerMaps?.amap) {
    $("#ownerMapLink").href = result.ownerMaps.amap;
    $("#ownerMapLink").hidden = false;
  }
}

function renderSessionState(status, result = {}) {
  switch (status) {
    case "scheduled":
    case "sending":
      renderScheduled(status);
      break;
    case "accepted":
      renderNotified();
      break;
    case "confirmed":
      if (result.ownerReply || result.confirmedAt) renderConfirmed(result);
      else renderRestoring();
      break;
    case "push_failed":
      renderFailure("微信通知服务暂时未受理，请稍后重新扫码再试。");
      break;
    case "cancelled":
      renderCancelled();
      break;
    default:
      renderRestoring();
  }
}

function renderRestoring() {
  $("#delayPanel").hidden = true;
  $("#phoneButton").hidden = true;
  $("#resultEyebrow").textContent = "正在读取状态";
  $("#resultTitle").textContent = "正在确认通知进度";
  $("#resultText").textContent = "请稍候。";
}

function renderScheduled(status = "scheduled") {
  $("#sendNowButton").disabled = status === "sending";
  $("#cancelButton").disabled = status === "sending";
  $("#sendNowButton").querySelector("span").textContent = "获取位置并立即发送";
  $("#delayPanel").hidden = false;
  $("#phoneButton").hidden = true;
  $("#callButton").hidden = true;
  $("#resultEyebrow").textContent = "防骚扰等待中";
  $("#resultTitle").textContent = status === "sending" ? "正在提交通知" : "通知将在倒计时后发送";
  $("#resultText").textContent = status === "sending"
    ? "正在连接微信通知服务，请稍候。"
    : "这是未共享位置时的安全缓冲，页面会清楚展示整个等待过程。";
  $("#notifiedStep").classList.remove("done");
  document.querySelectorAll(".progress-line")[0].classList.remove("active");
  clearInterval(state.countdownTimer);
  updateCountdown();
  state.countdownTimer = setInterval(updateCountdown, 1000);
}

function renderNotified() {
  clearInterval(state.countdownTimer);
  $("#delayPanel").hidden = true;
  $("#resultEyebrow").textContent = "通知已提交";
  $("#resultTitle").textContent = "提醒已交给微信服务";
  $("#resultText").textContent = "请稍等片刻。车主回复后，这里会自动更新。";
  $("#notifiedStep").classList.add("done");
  document.querySelectorAll(".progress-line")[0].classList.add("active");
  $("#phoneButton").hidden = state.session.phoneAvailable === false;
}

function updateCountdown() {
  if (!state.session?.notifyAt) return;
  const seconds = Math.max(0, Math.ceil((state.session.notifyAt - Date.now()) / 1000));
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = seconds % 60;
  $("#countdownText").textContent = `${String(minutesPart).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}`;
  if (seconds === 0) {
    clearInterval(state.countdownTimer);
    $("#resultTitle").textContent = "正在提交通知";
    $("#resultText").textContent = "倒计时已结束，正在连接微信通知服务。";
    $("#sendNowButton").disabled = true;
    $("#cancelButton").disabled = true;
    schedulePoll(100);
  }
}

async function expediteWithLocation() {
  if (!navigator.geolocation) {
    toast("当前浏览器不支持定位，通知仍会在倒计时后发送");
    return;
  }
  const button = $("#sendNowButton");
  button.disabled = true;
  button.querySelector("span").textContent = "正在获取位置…";
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        const response = await sessionFetch("expedite", {
          method: "POST",
          headers: { "content-type": "application/json", "x-movecar-client": "web" },
          body: JSON.stringify({ location: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          } }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "立即发送失败");
        state.session.status = result.status || "accepted";
        state.session.notifyAt = result.notifyAt || Date.now();
        sessionStorage.setItem("movecar-session", JSON.stringify(state.session));
        if (state.session.status === "confirmed") schedulePoll(0);
        else {
          renderSessionState(state.session.status, result);
          schedulePoll(100);
        }
        toast("位置已附上，正在立即提交通知");
      } catch (error) {
        button.disabled = false;
        button.querySelector("span").textContent = "获取位置并立即发送";
        toast(error.message);
      }
    },
    () => {
      button.disabled = false;
      button.querySelector("span").textContent = "获取位置并立即发送";
      toast("未获得定位权限，通知仍会在倒计时后发送");
    },
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 },
  );
}

async function cancelRequest() {
  const button = $("#cancelButton");
  button.disabled = true;
  try {
    const response = await sessionFetch("cancel", {
      method: "POST",
      headers: { "content-type": "application/json", "x-movecar-client": "web" },
      body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "取消失败");
    renderCancelled();
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

function renderCancelled() {
  clearTimeout(state.pollTimer);
  clearInterval(state.countdownTimer);
  sessionStorage.removeItem("movecar-session");
  state.session = null;
  $("#delayPanel").hidden = true;
  $("#resultEyebrow").textContent = "呼叫已取消";
  $("#resultTitle").textContent = "没有发送通知";
  $("#resultText").textContent = "这次呼叫已安全取消。如仍需要挪车，请重新扫码发起。";
  $("#phoneButton").hidden = true;
}

function renderFailure(text) {
  clearInterval(state.countdownTimer);
  $("#delayPanel").hidden = true;
  $("#resultEyebrow").textContent = "发送未成功";
  $("#resultTitle").textContent = "暂时未能提交通知";
  $("#resultText").textContent = text;
  $("#phoneButton").hidden = true;
}

async function revealPhone() {
  const button = $("#phoneButton");
  button.disabled = true;
  button.querySelector("span").textContent = "正在安全获取…";
  try {
    const response = await sessionFetch("phone");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "暂时无法获取电话");
    button.hidden = true;
    const callButton = $("#callButton");
    callButton.href = result.tel;
    $("#callButtonText").textContent = `拨打 ${result.maskedPhone}`;
    callButton.hidden = false;
  } catch (error) {
    button.disabled = false;
    button.querySelector("span").textContent = "仍需帮助？获取车主电话";
    toast(error.message);
  }
}

function sessionFetch(action, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${state.session.token}`);
  headers.set("accept", "application/json");
  return fetch(`/api/session/${state.session.id}/${action}`, {
    ...init,
    headers,
  });
}

function updateExpiry() {
  if (!state.session) return;
  const minutes = Math.max(1, Math.ceil((state.session.expiresAt - Date.now()) / 60000));
  $("#expiryText").textContent = `本次联系将在约 ${minutes} 分钟后自动失效`;
}

function expireSession(text) {
  clearTimeout(state.pollTimer);
  clearInterval(state.countdownTimer);
  sessionStorage.removeItem("movecar-session");
  state.session = null;
  $("#delayPanel").hidden = true;
  $("#ownerReply").hidden = true;
  $("#resultTitle").textContent = "本次呼叫已结束";
  $("#resultText").textContent = text || "会话已自动过期，如仍需帮助请重新扫码。";
  $("#phoneButton").hidden = true;
  $("#callButton").hidden = true;
}

function mountTurnstile(siteKey) {
  const mount = $("#turnstileMount");
  mount.hidden = false;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.addEventListener("load", () => {
    window.turnstile.render(mount, {
      sitekey: siteKey,
      theme: "light",
      size: "flexible",
      callback: (token) => { state.turnstileToken = token; },
      "expired-callback": () => { state.turnstileToken = null; },
      "error-callback": () => { state.turnstileToken = null; },
    });
  });
  document.head.append(script);
}

function resetTurnstile() {
  if (state.config?.turnstileSiteKey && window.turnstile) {
    state.turnstileToken = null;
    window.turnstile.reset();
  }
}

function showError(text) {
  formError.textContent = text;
  formError.hidden = false;
}

function hideError() { formError.hidden = true; }

let toastTimer;
function toast(text) {
  const element = $("#toast");
  element.textContent = text;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 2800);
}
