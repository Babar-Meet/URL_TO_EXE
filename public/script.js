const urlInput = document.getElementById("urlInput");
const appNameInput = document.getElementById("appNameInput");
const logoInput = document.getElementById("logoInput");
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

let userEditedAppName = false;
let analyzeTimer = null;
let analyzeController = null;
let statusPollTimer = null;
let etaTickTimer = null;
let statusSocket = null;
let wsFallbackTimer = null;
let latestServerJob = null;
let latestServerJobTimestamp = 0;
let activeJobId = "";
let detectedLogoUrl = "";
let customLogoObjectUrl = "";

urlInput.addEventListener("input", () => {
  if (!urlInput.value.trim()) {
    resetInsights();
    if (!userEditedAppName) {
      appNameInput.value = "";
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
  previewName.textContent = appNameInput.value.trim() || "-";
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

buildForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Please enter a website URL.", "error");
    return;
  }

  const appName = appNameInput.value.trim();
  const logoFile = logoInput.files && logoInput.files[0];

  stopRealtimeUpdates();
  resetBuildUiForStart();
  setStatus("", "");

  try {
    const payload = new FormData();
    payload.append("url", url);
    payload.append("appName", appName);

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

    previewName.textContent = appNameInput.value.trim() || data.appName || "-";

    if (detectedLogoUrl && !hasCustomLogoSelected()) {
      logoPreview.src = `${detectedLogoUrl}&_=${Date.now()}`;
      logoPreview.classList.add("ready");
    }
  } catch (_error) {
    // Ignore analyze errors while typing.
  }
}

function startBuildStatusUpdates(jobId) {
  stopRealtimeUpdates();
  activeJobId = jobId;
  startEtaTicker();

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
  latestServerJobTimestamp = Date.now();
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

function startEtaTicker() {
  if (etaTickTimer) {
    clearInterval(etaTickTimer);
  }

  etaTickTimer = setInterval(() => {
    if (!latestServerJob || isJobTerminal(latestServerJob)) {
      return;
    }

    const deltaSeconds = Math.max(
      0,
      Math.floor((Date.now() - latestServerJobTimestamp) / 1000),
    );

    const estimatedJob = {
      ...latestServerJob,
      etaSeconds: Math.max(
        0,
        Number(latestServerJob.etaSeconds || 0) - deltaSeconds,
      ),
      elapsedSeconds:
        Number(latestServerJob.elapsedSeconds || 0) + deltaSeconds,
    };

    renderBuildProgress(estimatedJob);
  }, 1000);
}

function renderBuildProgress(job) {
  stageLabel.textContent = job.stageLabel || "Processing";

  const progress = clampPercent(job.progress || 0);
  progressPercent.textContent = `${progress}%`;
  progressBar.style.width = `${progress}%`;
  progressBar.parentElement.setAttribute("aria-valuenow", String(progress));

  etaLabel.textContent = `ETA: ${formatDuration(job.etaSeconds)}`;
  elapsedLabel.textContent = `Elapsed: ${formatDuration(job.elapsedSeconds)}`;

  if (job.appName) {
    previewName.textContent = appNameInput.value.trim() || job.appName;
  }

  if (job.status === "running") {
    setStatus(
      `${job.stageLabel || "Processing"} (${progress}%) - ETA ${formatDuration(job.etaSeconds)}`,
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
  latestServerJobTimestamp = 0;

  renderBuildProgress({
    stageLabel: "Queued",
    progress: 1,
    etaSeconds: 230,
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

  if (etaTickTimer) {
    clearInterval(etaTickTimer);
    etaTickTimer = null;
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

function formatDuration(totalSeconds) {
  const safe = Number(totalSeconds);
  if (!Number.isFinite(safe) || safe <= 0) {
    return "< 1m";
  }

  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}
