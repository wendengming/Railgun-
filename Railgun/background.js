const RAILGUN_ORIGIN = "https://railgun.info";
const CHECKIN_URL = `${RAILGUN_ORIGIN}/api/user/checkin`;
const POINTS_URL = `${RAILGUN_ORIGIN}/api/user/points`;
const AUTHORIZATION_URL = `${RAILGUN_ORIGIN}/api/authorization`;
const LOGIN_URL = `${RAILGUN_ORIGIN}/api/login`;
const CHECKIN_REFERER = `${RAILGUN_ORIGIN}/console/checkin`;
const ALARM_NAME = "railgunCheckInAlarm";
const HISTORY_LIMIT = 30;
const GMAIL_FEED_URL = "https://mail.google.com/mail/feed/atom";

const DEFAULTS = {
  targetHour: 9,
  notifyEnabled: true,
  cookieString: "",
  autoLoginEnabled: false,
  railgunEmail: "",
  gmailKeywords: "railgun,access code,verification code,passcode,验证码,驗證碼"
};

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension("installed");
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtension("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void tryCheckIn("alarm", false);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "forceCheckIn") {
    void tryCheckIn("manual", true)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        sendResponse({ ok: false, error: message });
      });
    return true;
  }

  if (request.action === "testGmailFeed") {
    void testGmailFeed()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        sendResponse({ ok: false, error: message });
      });
    return true;
  }

  return false;
});

async function initializeExtension(reason) {
  await ensureDefaults();
  await configureHeaderRules().catch((error) => {
    console.warn("配置 Railgun 请求头规则失败", error);
  });
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: 60
  });

  await tryCheckIn(reason, false);
}

async function configureHeaderRules() {
  if (!chrome.declarativeNetRequest) {
    return;
  }

  const rules = [{
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: RAILGUN_ORIGIN },
        { header: "Referer", operation: "set", value: CHECKIN_REFERER }
      ]
    },
    condition: {
      urlFilter: "railgun.info/api/",
      resourceTypes: ["xmlhttprequest"]
    }
  }];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: rules
  });
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const updates = {};

  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (data[key] === undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function tryCheckIn(reason, isManual) {
  await ensureDefaults();
  await configureHeaderRules().catch((error) => {
    console.warn("配置 Railgun 请求头规则失败", error);
  });

  const data = await chrome.storage.local.get({
    ...DEFAULTS,
    lastCheckInDate: ""
  });

  const now = new Date();
  const today = formatLocalDate(now);
  const currentHour = now.getHours();

  if (!isManual) {
    if (data.lastCheckInDate === today) {
      return { skipped: true, message: `今天已经自动签到过：${today}` };
    }

    if (currentHour < Number(data.targetHour)) {
      return {
        skipped: true,
        message: `还没到设定时间：当前 ${currentHour} 点，目标 ${data.targetHour} 点`
      };
    }
  }

  let result;
  try {
    result = await performRailgunCheckIn(data);

    if (result.needsLogin && data.autoLoginEnabled) {
      const loginResult = await loginRailgunWithGmailCode(data, isManual);
      if (loginResult.success) {
        result = await performRailgunCheckIn({ ...data, cookieString: "" });
        result.message = `自动登录成功；${result.message}`;
        result.login = loginResult;
      } else {
        result = {
          ...result,
          message: `${result.message}；自动登录失败：${loginResult.message}`,
          shouldMarkDone: false,
          login: loginResult
        };
      }
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    result = {
      error: true,
      message: `签到执行失败：${message}`,
      shouldMarkDone: false
    };
  }

  await saveHistory(`${isManual ? "[手动]" : "[自动]"} ${result.message}`);

  if (!isManual && result.shouldMarkDone) {
    await chrome.storage.local.set({ lastCheckInDate: today });
  }

  if (data.notifyEnabled !== false) {
    await notify(isManual ? "Railgun 手动签到结果" : "Railgun 自动签到结果", result.message).catch((error) => {
      console.warn("通知发送失败", error);
    });
  }

  return result;
}

async function performRailgunCheckIn(data) {
  await applyStoredCookies(data.cookieString);

  const response = await fetch(CHECKIN_URL, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      token: "railgun.info"
    })
  });

  const payload = await parseJsonResponse(response);
  const needsLogin = isPermissionDenied(payload, response.status);

  if (!response.ok) {
    return {
      code: payload.code,
      data: payload,
      needsLogin,
      message: `接口请求失败：HTTP ${response.status}${payload.message ? `，${payload.message}` : ""}`,
      shouldMarkDone: false
    };
  }

  const pointsInfo = needsLogin ? null : await fetchPointsSnapshot();
  const shouldMarkDone = isCheckInDone(payload);

  return {
    code: payload.code,
    data: payload,
    pointsInfo,
    needsLogin,
    message: buildApiResultMessage(payload, pointsInfo),
    shouldMarkDone
  };
}

async function fetchPointsSnapshot() {
  try {
    const response = await fetch(POINTS_URL, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Accept": "application/json, text/plain, */*"
      }
    });

    if (!response.ok) {
      return null;
    }

    return await parseJsonResponse(response);
  } catch (error) {
    console.warn("读取 Railgun 积分快照失败", error);
    return null;
  }
}

async function loginRailgunWithGmailCode(data, interactive) {
  const email = String(data.railgunEmail || "").trim().toLowerCase();
  if (!email) {
    return {
      success: false,
      message: "未填写 Railgun 登录邮箱"
    };
  }

  const requestResult = await requestRailgunMailCode(email);
  if (!requestResult.ok) {
    return {
      success: false,
      message: requestResult.message
    };
  }

  const codeResult = await waitForGmailCode(data.gmailKeywords);
  if (!codeResult.code) {
    return {
      success: false,
      message: codeResult.message || "没有在 Gmail 中找到验证码"
    };
  }

  const loginResult = await postRailgunLogin(email, codeResult.code);
  if (!loginResult.success) {
    return loginResult;
  }

  return {
    success: true,
    code: codeResult.code,
    message: "邮箱验证码登录成功"
  };
}

async function requestRailgunMailCode(email) {
  const response = await fetch(AUTHORIZATION_URL, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      address: email,
      site: "railgun.info"
    })
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok || payload.code !== 0) {
    return {
      ok: false,
      message: payload.message || `发送邮箱验证码失败：HTTP ${response.status}`
    };
  }

  return {
    ok: true,
    message: payload.message || "验证码邮件已发送"
  };
}

async function postRailgunLogin(email, mailcode) {
  const response = await fetch(LOGIN_URL, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      mailcode
    })
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok || payload.code !== 0) {
    return {
      success: false,
      message: payload.message || `Railgun 登录失败：HTTP ${response.status}`,
      data: payload
    };
  }

  return {
    success: true,
    message: payload.message || "Railgun 登录成功",
    data: payload
  };
}

async function testGmailFeed() {
  const feed = await fetchGmailAtomFeed();
  const entries = splitGmailEntries(feed);
  return {
    count: entries.length,
    message: entries.length > 0
      ? `Gmail Feed 可读取，当前未读邮件 ${entries.length} 封。`
      : "Gmail Feed 可读取，但当前收件箱没有未读邮件。Railgun 新验证码邮件到达后仍可读取。"
  };
}

async function waitForGmailCode(keywords) {
  const startedAt = Date.now();
  const timeoutMs = 70000;
  const intervalMs = 5000;
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const feed = await fetchGmailAtomFeed();
      const code = findLatestGmailFeedCode(feed, keywords);
      if (code) {
        return { code };
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }

    await delay(intervalMs);
  }

  return {
    code: "",
    message: lastError || "等待 Gmail Feed 中出现验证码超时"
  };
}

async function fetchGmailAtomFeed() {
  const response = await fetch(`${GMAIL_FEED_URL}?_=${Date.now()}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Accept": "application/atom+xml,text/xml,application/xml,text/plain,*/*"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gmail Feed 请求失败：HTTP ${response.status}。请确认当前 Chrome 已登录 Gmail。`);
  }

  if (!/<feed[\s>]/i.test(text)) {
    throw new Error("没有读到 Gmail Feed。请先在当前 Chrome 登录 Gmail，并确认 https://mail.google.com/mail/feed/atom 可以打开。");
  }

  return text;
}

function findLatestGmailFeedCode(feedXml, keywords) {
  const keywordList = csvToList(keywords || DEFAULTS.gmailKeywords).map((keyword) => keyword.toLowerCase());
  const entries = splitGmailEntries(feedXml);

  for (const entry of entries) {
    const text = xmlToText(entry);
    const lowerText = text.toLowerCase();
    const matched = keywordList.length === 0 || keywordList.some((keyword) => lowerText.includes(keyword));
    if (matched) {
      const code = extractRailgunCode(text);
      if (code) {
        return code;
      }
    }
  }

  return "";
}

function splitGmailEntries(feedXml) {
  return String(feedXml || "").match(/<entry[\s\S]*?<\/entry>/gi) || [];
}

function xmlToText(xml) {
  return decodeXmlEntities(
    String(xml || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, " $1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, number) => String.fromCharCode(Number(number)));
}

function csvToList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractRailgunCode(text) {
  const source = String(text || "");
  const patterns = [
    /(?:railgun|access\s*code|verification\s*code|passcode|验证码|驗證碼|校验码|代碼|代码)[\s\S]{0,80}?([0-9]{4,8})/i,
    /\b([0-9]{6})\b/,
    /\b([A-Z0-9]{6})\b/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return "";
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      message: text.slice(0, 300)
    };
  }
}

async function applyStoredCookies(cookieString) {
  const cookies = parseCookieString(cookieString);
  if (cookies.length === 0) {
    return;
  }

  for (const cookie of cookies) {
    await chrome.cookies.set({
      url: `${RAILGUN_ORIGIN}/`,
      name: cookie.name,
      value: cookie.value,
      path: "/",
      secure: true,
      sameSite: "no_restriction"
    });
  }
}

function parseCookieString(cookieString) {
  if (!cookieString || !cookieString.trim()) {
    return [];
  }

  return cookieString
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) {
        return null;
      }

      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim()
      };
    })
    .filter((cookie) => cookie && cookie.name);
}

function isPermissionDenied(payload, status) {
  const message = String(payload && payload.message ? payload.message : "").toLowerCase();
  return status === 401 || payload.code === -2 || /permission|login|登录|登陆|unauthorized/.test(message);
}

function isCheckInDone(payload) {
  if (payload.code === 0) {
    return true;
  }

  const message = String(payload.message || "").toLowerCase();
  return [
    "already",
    "checked",
    "checkin",
    "check in",
    "repeat",
    "tomorrow",
    "claimed",
    "已签到",
    "已簽到",
    "签到成功",
    "簽到成功",
    "明天"
  ].some((keyword) => message.includes(keyword.toLowerCase()));
}

function buildApiResultMessage(payload, pointsInfo) {
  if (isPermissionDenied(payload, 200)) {
    return "接口返回未登录或无权限。";
  }

  const serverMessage = payload.message || (payload.code === 0 ? "签到成功" : "签到接口已返回");
  const delta = getNumber(payload.points);
  const currentPoints = getCurrentPoints(payload, pointsInfo);
  const parts = [`${serverMessage}`];

  if (delta !== null) {
    parts.push(`本次积分：${delta}`);
  }

  if (currentPoints !== null) {
    parts.push(`当前积分：${currentPoints}`);
  }

  return parts.join("；");
}

function getCurrentPoints(payload, pointsInfo) {
  const fromPayloadList = getLatestBalance(payload.list);
  if (fromPayloadList !== null) {
    return fromPayloadList;
  }

  const fromPointsInfo = getNumber(pointsInfo && pointsInfo.points);
  if (fromPointsInfo !== null) {
    return fromPointsInfo;
  }

  const fromHistory = getLatestBalance(pointsInfo && pointsInfo.history);
  if (fromHistory !== null) {
    return fromHistory;
  }

  return null;
}

function getLatestBalance(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }

  const value = getNumber(list[0] && list[0].balance);
  return value === null ? null : Math.round(value);
}

function getNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function saveHistory(message) {
  const data = await chrome.storage.local.get({ history: [] });
  const history = [{
    time: new Date().toLocaleString(),
    result: message
  }, ...data.history].slice(0, HISTORY_LIMIT);

  await chrome.storage.local.set({ history });
}

async function notify(title, message) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title,
    message
  });
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
