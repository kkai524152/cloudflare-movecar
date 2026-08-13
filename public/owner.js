const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.hash.slice(1));
const incomingSessionId = params.get("session");
const incomingOwnerToken = params.get("token");
const savedOwnerSession = readSavedOwnerSession();
const sessionId = incomingSessionId || savedOwnerSession?.sessionId;
const ownerToken = incomingOwnerToken || savedOwnerSession?.ownerToken;
let ownerLocation = null;
let locationEnabled = false;

if (incomingSessionId && incomingOwnerToken) {
  sessionStorage.setItem("movecar-owner-session", JSON.stringify({
    sessionId: incomingSessionId,
    ownerToken: incomingOwnerToken,
  }));
  history.replaceState(null, "", location.pathname);
}
bindEvents();
loadRequest();

function bindEvents() {
  document.querySelectorAll(".reply-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".reply-chip").forEach((item) => item.classList.remove("active"));
      chip.classList.add("active");
      $("#ownerReplyInput").value = chip.dataset.reply;
    });
  });
  $("#ownerReplyInput").addEventListener("input", () => {
    document.querySelectorAll(".reply-chip").forEach((item) => item.classList.remove("active"));
  });
  $("#ownerLocationButton").addEventListener("click", toggleLocation);
  $("#confirmButton").addEventListener("click", confirmRequest);
}

async function loadRequest() {
  if (!sessionId || !ownerToken) {
    showInvalid("链接不完整，请从最新的 PushPlus 通知中重新打开。");
    return;
  }
  try {
    const response = await apiFetch("status");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法读取呼叫信息");
    if (result.status === "confirmed") {
      showDone();
      return;
    }
    $("#requestMessage").textContent = result.message;
    $("#requestTime").textContent = relativeTime(result.createdAt);
    if (result.requesterMaps?.amap) {
      $("#requesterMap").href = result.requesterMaps.amap;
      $("#requesterMap").hidden = false;
      $("#noRequesterMap").hidden = true;
    }
    $("#ownerLoading").hidden = true;
    $("#ownerContent").hidden = false;
  } catch (error) {
    showInvalid(error.message);
  }
}

async function toggleLocation() {
  if (locationEnabled) {
    locationEnabled = false;
    ownerLocation = null;
    setLocationUi(false, "把我的位置分享给对方", "选填，仅本次呼叫可见");
    return;
  }
  if (!navigator.geolocation) {
    showError("当前浏览器不支持定位");
    return;
  }
  const button = $("#ownerLocationButton");
  button.disabled = true;
  setLocationUi(false, "正在获取位置…", "请允许浏览器获取位置");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      ownerLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      locationEnabled = true;
      button.disabled = false;
      setLocationUi(true, "我的位置已附上", `定位精度约 ${Math.round(position.coords.accuracy)} 米 · 点击取消`);
    },
    () => {
      button.disabled = false;
      setLocationUi(false, "把我的位置分享给对方", "定位未成功，仍可直接回复");
      showError("未能获取位置，您仍可不带位置回复");
    },
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 },
  );
}

function setLocationUi(selected, title, hint) {
  const button = $("#ownerLocationButton");
  button.classList.toggle("selected", selected);
  button.setAttribute("aria-pressed", String(selected));
  $("#ownerLocationTitle").textContent = title;
  $("#ownerLocationHint").textContent = hint;
}

async function confirmRequest() {
  const reply = $("#ownerReplyInput").value.trim();
  if (!reply) {
    showError("请填写一句回复");
    return;
  }
  hideError();
  const button = $("#confirmButton");
  button.disabled = true;
  button.querySelector("span").textContent = "正在回复…";
  try {
    const response = await apiFetch("confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-movecar-client": "web" },
      body: JSON.stringify({ reply, location: locationEnabled ? ownerLocation : null }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "回复失败");
    showDone();
  } catch (error) {
    button.disabled = false;
    button.querySelector("span").textContent = "我已收到，回复对方";
    showError(error.message);
  }
}

function apiFetch(action, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ownerToken}`);
  headers.set("accept", "application/json");
  return fetch(`/api/session/${sessionId}/${action}`, { ...init, headers });
}

function showDone() {
  $("#ownerLoading").hidden = true;
  $("#ownerContent").hidden = true;
  $("#ownerInvalid").hidden = true;
  $("#ownerDone").hidden = false;
}

function showInvalid(text) {
  sessionStorage.removeItem("movecar-owner-session");
  $("#ownerLoading").hidden = true;
  $("#ownerContent").hidden = true;
  $("#ownerDone").hidden = true;
  $("#ownerInvalidText").textContent = text;
  $("#ownerInvalid").hidden = false;
}

function readSavedOwnerSession() {
  try {
    return JSON.parse(sessionStorage.getItem("movecar-owner-session"));
  } catch {
    return null;
  }
}

function showError(text) {
  $("#ownerError").textContent = text;
  $("#ownerError").hidden = false;
}
function hideError() { $("#ownerError").hidden = true; }

function relativeTime(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
