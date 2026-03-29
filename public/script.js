const urlInput = document.getElementById("urlInput");
const appNameInput = document.getElementById("appNameInput");
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

buildForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Please enter a website URL.", "error");
    return;
  }

  const appName = appNameInput.value.trim();

  stopPolling();
  resetBuildUiForStart();
  setStatus("", "");

  try {
    const response = await fetch("/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, appName }),
    });

    const data = await response.json();

    if (!response.ok || !data.success || !data.jobId) {
      throw new Error(data.error || "Could not start build.");
    }

    pollBuildStatus(data.jobId);
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

    insights.classList.remove("hidden");

    if (!userEditedAppName) {
      appNameInput.value = data.appName || "";
    }

    previewName.textContent = appNameInput.value.trim() || data.appName || "-";

    if (data.logoUrl) {
      logoPreview.src = `${data.logoUrl}&_=${Date.now()}`;
      logoPreview.classList.add("ready");
    }
  } catch (_error) {
    // Ignore analyze errors while typing.
  }
}

async function pollBuildStatus(jobId) {
  stopPolling();

  const run = async () => {
    try {
      const response = await fetch(
        `/build-status/${encodeURIComponent(jobId)}`,
      );
      const data = await response.json();

      if (!response.ok || !data.success || !data.job) {
        throw new Error(data.error || "Failed to read build status.");
      }

      renderBuildProgress(data.job);

      if (data.job.status === "done") {
        setStatus("Done. Your EXE is ready to download.", "success");
        if (data.job.downloadUrl) {
          downloadLink.href = data.job.downloadUrl;
          downloadLink.classList.remove("hidden");
        }
        buildButton.disabled = false;
        stopPolling();
        return;
      }

      if (data.job.status === "failed") {
        setStatus(data.job.error || "Build failed.", "error");
        buildButton.disabled = false;
        stopPolling();
      }
    } catch (error) {
      setStatus(error.message || "Build status check failed.", "error");
      buildButton.disabled = false;
      stopPolling();
    }
  };

  await run();
  statusPollTimer = setInterval(run, 1200);
}

function renderBuildProgress(job) {
  insights.classList.remove("hidden");

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
      `${job.stageLabel || "Processing"} (${progress}%) • ETA ${formatDuration(job.etaSeconds)}`,
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
  insights.classList.remove("hidden");

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
  insights.classList.add("hidden");
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

function stopPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
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
