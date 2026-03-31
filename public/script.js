const urlInput = document.getElementById("urlInput");
const appNameInput = document.getElementById("appNameInput");
const appTitleInput = document.getElementById("appTitleInput");
const logoInput = document.getElementById("logoInput");
const automationEnabledInput = document.getElementById("automationEnabled");
const automationPanel = document.getElementById("automationPanel");
const automationStepsContainer = document.getElementById("automationSteps");
const addAutomationStepButton = document.getElementById(
  "addAutomationStepButton",
);
const buildForm = document.getElementById("buildForm");
const buildButton = document.getElementById("buildButton");
const statusBox = document.getElementById("status");
const downloadLink = document.getElementById("downloadLink");
const insights = document.getElementById("insights");
const logoPreview = document.getElementById("logoPreview");
const previewName = document.getElementById("previewName");
const stageLabel = document.getElementById("stageLabel");
const progressPercent = document.getElementById("progressPercent");
const progressBar = document.getElementById("progressBar");
const etaLabel = document.getElementById("etaLabel");
const elapsedLabel = document.getElementById("elapsedLabel");
const stageList = document.getElementById("stageList");

const DEFAULT_AUTOMATION_DELAY_MS = 500;
const MAX_AUTOMATION_STEPS = 120;
const AUTOMATION_ACTIONS = [
  {
    value: "type",
    label: "Type Text",
    requiresSelector: true,
    requiresValue: true,
    valueLabel: "Value",
    requiresKey: false,
    valueIsNumeric: false,
  },
  {
    value: "click",
    label: "Click Element",
    requiresSelector: true,
    requiresValue: false,
    valueLabel: "",
    requiresKey: false,
    valueIsNumeric: false,
  },
  {
    value: "radio",
    label: "Select Radio Button",
    requiresSelector: true,
    requiresValue: false,
    valueLabel: "",
    requiresKey: false,
    valueIsNumeric: false,
  },
  {
    value: "select",
    label: "Select Dropdown Option",
    requiresSelector: true,
    requiresValue: true,
    valueLabel: "Option Value",
    requiresKey: false,
    valueIsNumeric: false,
  },
  {
    value: "localStorage",
    label: "Set LocalStorage",
    requiresSelector: false,
    requiresValue: true,
    valueLabel: "Value",
    requiresKey: true,
    valueIsNumeric: false,
  },
  {
    value: "wait",
    label: "Wait (Delay)",
    requiresSelector: false,
    requiresValue: true,
    valueLabel: "Wait (ms)",
    requiresKey: false,
    valueIsNumeric: true,
  },
];

let userEditedAppName = false;
let userEditedAppTitle = false;
let analyzeTimer = null;
let analyzeController = null;
let statusPollTimer = null;
let statusSocket = null;
let wsFallbackTimer = null;
let latestServerJob = null;
let activeJobId = "";
let detectedLogoUrl = "";
let customLogoObjectUrl = "";
let automationSteps = [];

urlInput.addEventListener("input", () => {
  if (!urlInput.value.trim()) {
    resetInsights();
    if (!userEditedAppName) {
      appNameInput.value = "";
    }
    if (!userEditedAppTitle) {
      appTitleInput.value = "";
    }
    return;
  }

  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    analyzeUrl(urlInput.value);
  }, 350);
});

appNameInput.addEventListener("input", () => {
  userEditedAppName = appNameInput.value.trim().length > 0;
  const nextAppName = appNameInput.value.trim();
  previewName.textContent = nextAppName || "-";

  if (!userEditedAppTitle) {
    appTitleInput.value = nextAppName;
  }
});

appTitleInput.addEventListener("input", () => {
  userEditedAppTitle = appTitleInput.value.trim().length > 0;
});

logoInput.addEventListener("change", () => {
  if (customLogoObjectUrl) {
    URL.revokeObjectURL(customLogoObjectUrl);
    customLogoObjectUrl = "";
  }

  const file = logoInput.files && logoInput.files[0];
  if (file) {
    customLogoObjectUrl = URL.createObjectURL(file);
    logoPreview.src = customLogoObjectUrl;
    logoPreview.classList.add("ready");
    return;
  }

  if (detectedLogoUrl) {
    logoPreview.src = `${detectedLogoUrl}&_=${Date.now()}`;
    logoPreview.classList.add("ready");
    return;
  }

  logoPreview.removeAttribute("src");
  logoPreview.classList.remove("ready");
});

if (automationEnabledInput) {
  automationEnabledInput.addEventListener("change", () => {
    setAutomationEnabled(Boolean(automationEnabledInput.checked));
  });
}

if (addAutomationStepButton) {
  addAutomationStepButton.addEventListener("click", () => {
    addAutomationStep();
  });
}

initializeAutomationUi();

buildForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Please enter a website URL.", "error");
    return;
  }

  const appName = appNameInput.value.trim();
  const appTitle = appTitleInput.value.trim();
  const logoFile = logoInput.files && logoInput.files[0];
  const automationPayload = buildAutomationPayload();

  stopRealtimeUpdates();
  resetBuildUiForStart();
  setStatus("", "");

  try {
    const payload = new FormData();
    payload.append("url", url);
    payload.append("appName", appName);
    payload.append("appTitle", appTitle);
    payload.append(
      "automationEnabled",
      automationPayload.enabled ? "true" : "false",
    );

    if (automationPayload.enabled) {
      payload.append("automation", JSON.stringify(automationPayload.steps));
    }

    if (logoFile) {
      payload.append("logoFile", logoFile);
    }

    const response = await fetch("/build", {
      method: "POST",
      body: payload,
    });

    const data = await response.json();

    if (!response.ok || !data.success || !data.jobId) {
      throw new Error(data.error || "Could not start build.");
    }

    startBuildStatusUpdates(data.jobId);
  } catch (error) {
    setStatus(error.message || "Build failed.", "error");
    buildButton.disabled = false;
  }
});

async function analyzeUrl(rawUrl) {
  try {
    const normalized = normalizeUrl(rawUrl);

    if (analyzeController) {
      analyzeController.abort();
    }

    analyzeController = new AbortController();
    const response = await fetch(
      `/analyze?url=${encodeURIComponent(normalized)}`,
      {
        signal: analyzeController.signal,
      },
    );

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    if (!data.success) {
      return;
    }

    detectedLogoUrl = data.logoUrl || "";

    if (!userEditedAppName) {
      appNameInput.value = data.appName || "";
    }

    if (!userEditedAppTitle) {
      appTitleInput.value = data.appTitle || data.appName || "";
    }

    previewName.textContent = appNameInput.value.trim() || data.appName || "-";

    if (detectedLogoUrl && !hasCustomLogoSelected()) {
      logoPreview.src = `${detectedLogoUrl}&_=${Date.now()}`;
      logoPreview.classList.add("ready");
    }
  } catch (_error) {
    // Ignore analyze errors while typing.
  }
}

function initializeAutomationUi() {
  if (!automationEnabledInput || !automationPanel) {
    return;
  }

  setAutomationEnabled(Boolean(automationEnabledInput.checked));
}

function setAutomationEnabled(enabled) {
  if (!automationEnabledInput || !automationPanel) {
    return;
  }

  const isEnabled = Boolean(enabled);
  automationEnabledInput.checked = isEnabled;
  automationPanel.classList.toggle("hidden", !isEnabled);

  if (isEnabled && automationSteps.length === 0) {
    addAutomationStep();
    return;
  }

  renderAutomationSteps();
}

function addAutomationStep(initialType = "click") {
  if (automationSteps.length >= MAX_AUTOMATION_STEPS) {
    setStatus(
      `You can add up to ${MAX_AUTOMATION_STEPS} automation steps.`,
      "error",
    );
    return;
  }

  automationSteps.push(createAutomationStep(initialType));
  renderAutomationSteps();
}

function createAutomationStep(initialType) {
  const stepType = normalizeAutomationType(initialType);
  const defaults = {
    id: generateAutomationStepId(),
    type: stepType,
    selector: "",
    value: "",
    key: "",
    delay: DEFAULT_AUTOMATION_DELAY_MS,
  };

  if (stepType === "wait") {
    defaults.value = DEFAULT_AUTOMATION_DELAY_MS;
  }

  return defaults;
}

function generateAutomationStepId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renderAutomationSteps() {
  if (!automationStepsContainer) {
    return;
  }

  automationStepsContainer.textContent = "";

  if (automationSteps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-automation";
    empty.textContent = "No automation steps added yet.";
    automationStepsContainer.appendChild(empty);
    return;
  }

  automationSteps.forEach((step, index) => {
    const action = getAutomationActionConfig(step.type);
    const card = document.createElement("article");
    card.className = "automation-step-card";

    const header = document.createElement("div");
    header.className = "automation-step-header";

    const title = document.createElement("p");
    title.className = "automation-step-title";
    title.textContent = `Step ${index + 1}`;

    const controls = document.createElement("div");
    controls.className = "automation-step-controls";

    const moveUpButton = document.createElement("button");
    moveUpButton.type = "button";
    moveUpButton.className = "step-control-button";
    moveUpButton.textContent = "Up";
    moveUpButton.disabled = index === 0;
    moveUpButton.addEventListener("click", () => {
      moveAutomationStep(index, -1);
    });

    const moveDownButton = document.createElement("button");
    moveDownButton.type = "button";
    moveDownButton.className = "step-control-button";
    moveDownButton.textContent = "Down";
    moveDownButton.disabled = index === automationSteps.length - 1;
    moveDownButton.addEventListener("click", () => {
      moveAutomationStep(index, 1);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "step-control-button danger";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      removeAutomationStep(index);
    });

    controls.appendChild(moveUpButton);
    controls.appendChild(moveDownButton);
    controls.appendChild(removeButton);

    header.appendChild(title);
    header.appendChild(controls);
    card.appendChild(header);

    const fields = document.createElement("div");
    fields.className = "automation-fields";

    const actionSelect = document.createElement("select");
    AUTOMATION_ACTIONS.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      if (item.value === action.value) {
        option.selected = true;
      }
      actionSelect.appendChild(option);
    });

    actionSelect.addEventListener("change", () => {
      automationSteps[index].type = normalizeAutomationType(actionSelect.value);
      if (automationSteps[index].type === "wait") {
        automationSteps[index].value = sanitizeAutomationWaitValue(
          automationSteps[index].value,
        );
      }
      renderAutomationSteps();
    });

    fields.appendChild(createAutomationField("Action Type", actionSelect));

    const selectorInput = document.createElement("input");
    selectorInput.type = "text";
    selectorInput.placeholder = "rblRole_1 or #rblRole_1";
    selectorInput.value = String(step.selector || "");
    selectorInput.addEventListener("input", () => {
      automationSteps[index].selector = selectorInput.value;
    });
    const selectorField = createAutomationField(
      "Selector (ID or CSS)",
      selectorInput,
    );
    selectorField.classList.toggle("hidden", !action.requiresSelector);
    fields.appendChild(selectorField);

    const valueInput = document.createElement("input");
    valueInput.type = action.valueIsNumeric ? "number" : "text";
    valueInput.placeholder = action.valueIsNumeric ? "2000" : "Enter value";
    if (action.valueIsNumeric) {
      valueInput.min = "0";
      valueInput.step = "100";
      valueInput.value = String(sanitizeAutomationWaitValue(step.value));
      valueInput.addEventListener("change", () => {
        const safeWait = sanitizeAutomationWaitValue(valueInput.value);
        automationSteps[index].value = safeWait;
        valueInput.value = String(safeWait);
      });
    } else {
      valueInput.value = String(step.value || "");
      valueInput.addEventListener("input", () => {
        automationSteps[index].value = valueInput.value;
      });
    }
    const valueField = createAutomationField(
      action.valueLabel || "Value",
      valueInput,
    );
    valueField.classList.toggle("hidden", !action.requiresValue);
    fields.appendChild(valueField);

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.placeholder = "storageKey";
    keyInput.value = String(step.key || "");
    keyInput.addEventListener("input", () => {
      automationSteps[index].key = keyInput.value;
    });
    const keyField = createAutomationField("Key", keyInput);
    keyField.classList.toggle("hidden", !action.requiresKey);
    fields.appendChild(keyField);

    const delayInput = document.createElement("input");
    delayInput.type = "number";
    delayInput.min = "0";
    delayInput.step = "100";
    delayInput.value = String(sanitizeAutomationDelay(step.delay));
    delayInput.addEventListener("change", () => {
      const safeDelay = sanitizeAutomationDelay(delayInput.value);
      automationSteps[index].delay = safeDelay;
      delayInput.value = String(safeDelay);
    });
    fields.appendChild(createAutomationField("Delay (ms)", delayInput));

    card.appendChild(fields);
    automationStepsContainer.appendChild(card);
  });
}

function createAutomationField(labelText, control) {
  const wrapper = document.createElement("label");
  wrapper.className = "automation-field";

  const title = document.createElement("span");
  title.className = "automation-field-label";
  title.textContent = labelText;

  wrapper.appendChild(title);
  wrapper.appendChild(control);

  return wrapper;
}

function moveAutomationStep(index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= automationSteps.length) {
    return;
  }

  const [step] = automationSteps.splice(index, 1);
  automationSteps.splice(nextIndex, 0, step);
  renderAutomationSteps();
}

function removeAutomationStep(index) {
  if (index < 0 || index >= automationSteps.length) {
    return;
  }

  automationSteps.splice(index, 1);
  renderAutomationSteps();
}

function buildAutomationPayload() {
  const enabled = Boolean(
    automationEnabledInput && automationEnabledInput.checked,
  );
  if (!enabled) {
    return { enabled: false, steps: [] };
  }

  const steps = automationSteps.slice(0, MAX_AUTOMATION_STEPS).map((step) => {
    const action = getAutomationActionConfig(step.type);
    const normalized = {
      type: action.value,
      delay: sanitizeAutomationDelay(step.delay),
    };

    if (action.requiresSelector) {
      normalized.selector = sanitizeAutomationSelector(step.selector);
    }

    if (action.requiresValue) {
      normalized.value = action.valueIsNumeric
        ? sanitizeAutomationWaitValue(step.value)
        : sanitizeAutomationValue(step.value);
    }

    if (action.requiresKey) {
      normalized.key = sanitizeAutomationKey(step.key);
    }

    return normalized;
  });

  return { enabled: true, steps };
}

function getAutomationActionConfig(type) {
  const normalizedType = normalizeAutomationType(type);
  return (
    AUTOMATION_ACTIONS.find((action) => action.value === normalizedType) ||
    AUTOMATION_ACTIONS[0]
  );
}

function normalizeAutomationType(value) {
  const normalized = String(value || "").trim();
  const found = AUTOMATION_ACTIONS.find((item) => item.value === normalized);
  return found ? found.value : "click";
}

function sanitizeAutomationSelector(selector) {
  const trimmed = String(selector || "")
    .trim()
    .slice(0, 400);

  if (!trimmed) {
    return "";
  }

  if (looksLikeCssSelector(trimmed)) {
    return trimmed;
  }

  return toIdSelector(trimmed);
}

function looksLikeCssSelector(selector) {
  const firstChar = selector.charAt(0);

  if (
    firstChar === "#" ||
    firstChar === "." ||
    firstChar === "[" ||
    firstChar === ":" ||
    firstChar === "*"
  ) {
    return true;
  }

  return /[\s>+~,:[\]()=]/.test(selector);
}

function toIdSelector(value) {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    return `#${value}`;
  }

  return `[id="${escapeCssAttributeValue(value)}"]`;
}

function escapeCssAttributeValue(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function sanitizeAutomationValue(value) {
  return String(value ?? "").slice(0, 4000);
}

function sanitizeAutomationKey(value) {
  return String(value || "")
    .trim()
    .slice(0, 200);
}

function sanitizeAutomationWaitValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_AUTOMATION_DELAY_MS;
  }

  return Math.max(0, Math.min(600000, Math.round(n)));
}

function sanitizeAutomationDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_AUTOMATION_DELAY_MS;
  }

  return Math.max(0, Math.min(600000, Math.round(n)));
}

function startBuildStatusUpdates(jobId) {
  stopRealtimeUpdates();
  activeJobId = jobId;

  const wsEnabled = connectStatusSocket(jobId);
  if (!wsEnabled) {
    startStatusPolling(jobId);
  }
}

function connectStatusSocket(jobId) {
  if (
    typeof window === "undefined" ||
    typeof window.WebSocket === "undefined"
  ) {
    return false;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}/ws/build-status?jobId=${encodeURIComponent(jobId)}`;
  let hasReceivedMessage = false;

  try {
    statusSocket = new window.WebSocket(wsUrl);
  } catch (_error) {
    statusSocket = null;
    return false;
  }

  wsFallbackTimer = setTimeout(() => {
    if (activeJobId === jobId && !hasReceivedMessage && !statusPollTimer) {
      startStatusPolling(jobId);
    }
  }, 2500);

  statusSocket.addEventListener("message", (event) => {
    hasReceivedMessage = true;

    try {
      const data = JSON.parse(String(event.data || "{}"));
      if (data.success && data.job) {
        handleJobUpdate(data.job);
      }
    } catch (_error) {
      // Ignore transient socket payload parse issues.
    }
  });

  statusSocket.addEventListener("error", () => {
    if (activeJobId === jobId && !statusPollTimer) {
      startStatusPolling(jobId);
    }
  });

  statusSocket.addEventListener("close", () => {
    statusSocket = null;

    if (wsFallbackTimer) {
      clearTimeout(wsFallbackTimer);
      wsFallbackTimer = null;
    }

    if (
      activeJobId === jobId &&
      !isJobTerminal(latestServerJob) &&
      !statusPollTimer
    ) {
      startStatusPolling(jobId);
    }
  });

  return true;
}

function startStatusPolling(jobId) {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
  }

  const run = async () => {
    if (activeJobId !== jobId) {
      return;
    }

    try {
      const response = await fetch(
        `/build-status/${encodeURIComponent(jobId)}`,
      );
      const data = await response.json();

      if (!response.ok || !data.success || !data.job) {
        throw new Error(data.error || "Failed to read build status.");
      }

      handleJobUpdate(data.job);
    } catch (error) {
      setStatus(error.message || "Build status check failed.", "error");
      buildButton.disabled = false;
      stopRealtimeUpdates();
    }
  };

  run();
  statusPollTimer = setInterval(run, 1000);
}

function handleJobUpdate(job) {
  latestServerJob = job;
  renderBuildProgress(job);

  if (job.status === "done") {
    setStatus("Done. Your EXE is ready to download.", "success");
    if (job.downloadUrl) {
      downloadLink.href = job.downloadUrl;
      downloadLink.classList.remove("hidden");
    }
    buildButton.disabled = false;
    stopRealtimeUpdates();
    return;
  }

  if (job.status === "failed") {
    setStatus(job.error || "Build failed.", "error");
    buildButton.disabled = false;
    stopRealtimeUpdates();
  }
}

function renderBuildProgress(job) {
  stageLabel.textContent = job.stageLabel || "Processing";

  const progress = clampPercent(job.progress || 0);
  progressPercent.textContent = `${progress}%`;
  progressBar.style.width = `${progress}%`;
  progressBar.parentElement.setAttribute("aria-valuenow", String(progress));

  const etaText = isJobTerminal(job)
    ? "0s"
    : formatDuration(job.etaSeconds, {
        fallback: "Calculating...",
        minOneSecond: true,
      });

  etaLabel.textContent = `ETA: ${etaText}`;
  elapsedLabel.textContent = `Elapsed: ${formatDuration(job.elapsedSeconds, { fallback: "0s" })}`;

  if (job.appName) {
    previewName.textContent = appNameInput.value.trim() || job.appName;
  }

  if (job.status === "running") {
    setStatus(
      `${job.stageLabel || "Processing"} (${progress}%) - ETA ${etaText}`,
      "",
    );
  }

  markStageProgress(job.stageKey, job.status);
}

function markStageProgress(stageKey, status) {
  const nodes = Array.from(stageList.querySelectorAll("li"));
  const currentIndex = nodes.findIndex(
    (node) => node.dataset.stage === stageKey,
  );

  nodes.forEach((node, index) => {
    node.classList.remove("done", "active");

    if (status === "done") {
      node.classList.add("done");
      return;
    }

    if (currentIndex === -1) {
      return;
    }

    if (index < currentIndex) {
      node.classList.add("done");
    }

    if (index === currentIndex) {
      node.classList.add("active");
    }
  });
}

function resetBuildUiForStart() {
  buildButton.disabled = true;
  downloadLink.classList.add("hidden");
  latestServerJob = null;

  renderBuildProgress({
    stageLabel: "Queued",
    progress: 1,
    etaSeconds: null,
    elapsedSeconds: 0,
    stageKey: "validating",
    status: "running",
    appName: appNameInput.value.trim(),
  });
}

function resetInsights() {
  detectedLogoUrl = "";
  logoPreview.removeAttribute("src");
  logoPreview.classList.remove("ready");
  previewName.textContent = "-";
  stageLabel.textContent = "Waiting...";
  progressPercent.textContent = "0%";
  progressBar.style.width = "0%";
  etaLabel.textContent = "ETA: --";
  elapsedLabel.textContent = "Elapsed: --";
  markStageProgress("", "idle");
}

function hasCustomLogoSelected() {
  return Boolean(logoInput.files && logoInput.files.length > 0);
}

function isJobTerminal(job) {
  return Boolean(job && (job.status === "done" || job.status === "failed"));
}

function stopRealtimeUpdates() {
  activeJobId = "";

  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }

  if (wsFallbackTimer) {
    clearTimeout(wsFallbackTimer);
    wsFallbackTimer = null;
  }

  if (statusSocket) {
    try {
      statusSocket.close();
    } catch (_error) {
      // Ignore close errors.
    }
    statusSocket = null;
  }
}

function setStatus(message, type) {
  if (!message) {
    statusBox.textContent = "";
    statusBox.classList.add("hidden");
    statusBox.classList.remove("success", "error");
    return;
  }

  statusBox.textContent = message;
  statusBox.classList.remove("hidden", "success", "error");

  if (type === "success") {
    statusBox.classList.add("success");
  } else if (type === "error") {
    statusBox.classList.add("error");
  }
}

function normalizeUrl(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) {
    throw new Error("Empty URL");
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function clampPercent(value) {
  const n = Number(value);
  if (Number.isNaN(n)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatDuration(totalSeconds, options = {}) {
  const fallback = String(options.fallback || "--");
  const minOneSecond = Boolean(options.minOneSecond);
  const safe = Number(totalSeconds);
  if (!Number.isFinite(safe)) {
    return fallback;
  }

  let roundedSeconds = Math.round(safe);
  if (minOneSecond && roundedSeconds <= 0) {
    roundedSeconds = 1;
  }

  if (roundedSeconds < 0) {
    return fallback;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;

  if (minutes <= 0) {
    return `${roundedSeconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}
