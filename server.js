const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");
const { PNG } = require("pngjs");
const pngToIco = require("png-to-ico");
const sharp = require("sharp");
const multer = require("multer");
const { WebSocketServer, WebSocket } = require("ws");
const { parse: parseDomain } = require("tldts");

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

const ROOT_DIR = __dirname;
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const APP_NAME_MAX_LENGTH = 80;
const APP_SLUG_MAX_LENGTH = 60;

const buildJobs = new Map();
const buildStatusSubscribers = new Map();
const JOB_RETENTION_MS = 1000 * 60 * 60;
const buildStatusSocketServer = new WebSocketServer({
  server,
  path: "/ws/build-status",
});

const BUILD_STAGES = {
  queued: { label: "Queued", progress: 1 },
  validating: { label: "Validating URL", progress: 5 },
  fetchingLogo: { label: "Fetching logo", progress: 15 },
  preparingProject: {
    label: "Preparing Electron project",
    progress: 28,
  },
  installingDeps: {
    label: "Installing dependencies",
    progress: 45,
  },
  packaging: { label: "Packaging instant EXE", progress: 82 },
  finalizing: { label: "Finalizing output", progress: 96 },
  done: { label: "Completed", progress: 100 },
  failed: { label: "Failed", progress: 100 },
};

const STAGE_SEQUENCE = [
  "validating",
  "fetchingLogo",
  "preparingProject",
  "installingDeps",
  "packaging",
  "finalizing",
];

const STAGE_DEFAULT_DURATIONS_SECONDS = {
  validating: 4,
  fetchingLogo: 10,
  preparingProject: 8,
  installingDeps: 55,
  packaging: 140,
  finalizing: 8,
};

const stageDurationStats = Object.fromEntries(
  STAGE_SEQUENCE.map((stageKey) => [
    stageKey,
    {
      avgSeconds: STAGE_DEFAULT_DURATIONS_SECONDS[stageKey],
      samples: 0,
    },
  ]),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

buildStatusSocketServer.on("connection", (socket, request) => {
  let jobId = "";

  try {
    const parsedUrl = new URL(String(request.url || ""), "http://localhost");
    jobId = String(parsedUrl.searchParams.get("jobId") || "").trim();
  } catch (_error) {
    jobId = "";
  }

  if (!jobId) {
    socket.close(1008, "Missing jobId");
    return;
  }

  if (!buildJobs.has(jobId)) {
    socket.send(
      JSON.stringify({ success: false, error: "Build job not found." }),
    );
    socket.close(1008, "Build job not found");
    return;
  }

  addBuildStatusSubscriber(jobId, socket);
  sendJobStatusToSocket(jobId, socket);

  socket.on("close", () => {
    removeBuildStatusSubscriber(jobId, socket);
  });

  socket.on("error", () => {
    removeBuildStatusSubscriber(jobId, socket);
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/analyze", async (req, res) => {
  const { url } = req.query;

  try {
    const normalized = normalizeUrl(String(url || ""));
    const appName = deriveAppName(normalized);
    const logoUrl = `/logo?url=${encodeURIComponent(normalized)}`;

    return res.json({ success: true, appName, logoUrl });
  } catch (_error) {
    return res.status(400).json({ success: false, error: "Invalid URL." });
  }
});

app.get("/logo", async (req, res) => {
  const { url } = req.query;

  try {
    const normalized = normalizeUrl(String(url || ""));
    const urlObj = new URL(normalized);

    let iconBuffer;
    try {
      iconBuffer = await fetchFaviconBuffer(urlObj, 5000);
    } catch (_error) {
      iconBuffer = createFallbackPng();
    }

    res.setHeader("Cache-Control", "public, max-age=1800");
    res.type(detectMimeType(iconBuffer));
    return res.send(iconBuffer);
  } catch (_error) {
    const fallback = createFallbackPng();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("image/png");
    return res.send(fallback);
  }
});

app.post("/build", upload.single("logoFile"), (req, res) => {
  const { url, appName } = req.body || {};
  const uploadedLogoBuffer =
    req.file && Buffer.isBuffer(req.file.buffer) ? req.file.buffer : null;

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(String(url || "").trim());
  } catch (_error) {
    return res.status(400).json({ success: false, error: "Invalid URL." });
  }

  const resolvedAppName = sanitizeDisplayName(
    String(appName || "").trim() || deriveAppName(normalizedUrl),
  );

  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const startedAt = Date.now();

  buildJobs.set(jobId, {
    id: jobId,
    status: "queued",
    stageKey: "queued",
    stageLabel: BUILD_STAGES.queued.label,
    progress: BUILD_STAGES.queued.progress,
    stageStartedAt: startedAt,
    startedAt,
    updatedAt: startedAt,
    appName: resolvedAppName,
    url: normalizedUrl,
    hasCustomLogo: Boolean(uploadedLogoBuffer),
    downloadUrl: null,
    error: null,
  });

  runBuildJob(jobId, normalizedUrl, resolvedAppName, uploadedLogoBuffer).catch(
    () => {
      // The job object is updated inside runBuildJob on error.
    },
  );

  return res.status(202).json({ success: true, jobId });
});

app.get("/build-status/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = buildJobs.get(jobId);

  if (!job) {
    return res
      .status(404)
      .json({ success: false, error: "Build job not found." });
  }

  return res.json({ success: true, job: formatJobPayload(job) });
});

app.get("/download/:fileName", async (req, res) => {
  const safeFileName = path.basename(String(req.params.fileName || ""));
  const filePath = path.join(OUTPUT_DIR, safeFileName);

  try {
    await fs.access(filePath);
    return res.download(filePath, safeFileName);
  } catch (_error) {
    return res.status(404).json({ success: false, error: "File not found." });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: "Uploaded logo is too large. Maximum size is 8MB.",
      });
    }

    return res.status(400).json({
      success: false,
      error: "Logo upload failed. Please use a valid image file.",
    });
  }

  if (error) {
    return res.status(500).json({
      success: false,
      error: "Unexpected server error.",
    });
  }

  return next();
});

server.listen(PORT, async () => {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  setInterval(cleanupOldJobs, 1000 * 60 * 10).unref();
  setInterval(broadcastActiveJobStatuses, 1000).unref();

  console.log(`URL to EXE builder running at http://localhost:${PORT}`);
});

async function runBuildJob(jobId, normalizedUrl, appName, customLogoBuffer) {
  const urlObj = new URL(normalizedUrl);
  const jobDir = path.join(TEMP_DIR, jobId);
  const assetsDir = path.join(jobDir, "assets");

  try {
    setJobStage(jobId, "validating");

    setJobStage(jobId, "fetchingLogo");
    await fs.mkdir(assetsDir, { recursive: true });
    await writeIconFile(urlObj, assetsDir, customLogoBuffer);

    setJobStage(jobId, "preparingProject");
    await writeElectronProject(jobDir, normalizedUrl, appName);

    setJobStage(jobId, "installingDeps");
    await runCommand("npm", ["install", "--no-audit", "--no-fund"], jobDir, {
      timeoutMs: 1000 * 60 * 6,
    });

    setJobStage(jobId, "packaging");
    await runCommand(
      "npx",
      ["electron-builder", "--win", "portable", "--publish", "never"],
      jobDir,
      { timeoutMs: 1000 * 60 * 8 },
    );

    setJobStage(jobId, "finalizing");
    const builtExePath = await findBuiltExe(path.join(jobDir, "dist"));
    if (!builtExePath) {
      throw new Error("Build completed, but no EXE was produced.");
    }

    const outputFileName = `${slugifyName(appName)}-${jobId}.exe`;
    const finalOutputPath = path.join(OUTPUT_DIR, outputFileName);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.copyFile(builtExePath, finalOutputPath);

    const job = buildJobs.get(jobId);
    if (job) {
      finalizeCurrentStage(job, Date.now());
      job.status = "done";
      job.stageKey = "done";
      job.stageLabel = BUILD_STAGES.done.label;
      job.progress = BUILD_STAGES.done.progress;
      job.downloadUrl = `/download/${encodeURIComponent(outputFileName)}`;
      job.updatedAt = Date.now();
      broadcastJobStatus(jobId);
    }
  } catch (error) {
    const job = buildJobs.get(jobId);
    if (job) {
      finalizeCurrentStage(job, Date.now());
      job.status = "failed";
      job.stageKey = "failed";
      job.stageLabel = BUILD_STAGES.failed.label;
      job.progress = 100;
      job.error = simplifyError(error);
      job.updatedAt = Date.now();
      broadcastJobStatus(jobId);
    }
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

function setJobStage(jobId, stageKey) {
  const job = buildJobs.get(jobId);
  const stage = BUILD_STAGES[stageKey];
  const now = Date.now();

  if (!job || !stage) {
    return;
  }

  finalizeCurrentStage(job, now);

  job.status = "running";
  job.stageKey = stageKey;
  job.stageLabel = stage.label;
  job.progress = stage.progress;
  job.stageStartedAt = now;
  job.updatedAt = now;
  broadcastJobStatus(jobId);
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [jobId, job] of buildJobs.entries()) {
    const finished = job.status === "done" || job.status === "failed";
    if (finished && now - job.updatedAt > JOB_RETENTION_MS) {
      closeJobStatusSubscribers(jobId);
      buildJobs.delete(jobId);
    }
  }
}

function formatJobPayload(job) {
  const now = Date.now();

  return {
    id: job.id,
    status: job.status,
    stageKey: job.stageKey,
    stageLabel: job.stageLabel,
    progress: job.progress,
    etaSeconds: calculateDynamicEtaSeconds(job, now),
    elapsedSeconds: Math.max(0, Math.round((now - job.startedAt) / 1000)),
    appName: job.appName,
    hasCustomLogo: Boolean(job.hasCustomLogo),
    downloadUrl: job.downloadUrl,
    error: job.error,
  };
}

function finalizeCurrentStage(job, now) {
  if (!job || !job.stageStartedAt || job.status !== "running") {
    return;
  }

  const stageKey = String(job.stageKey || "");
  if (!STAGE_DEFAULT_DURATIONS_SECONDS[stageKey]) {
    return;
  }

  const durationSeconds = Math.max(
    1,
    Math.round((now - job.stageStartedAt) / 1000),
  );

  recordStageDuration(stageKey, durationSeconds);
}

function recordStageDuration(stageKey, durationSeconds) {
  const stats = stageDurationStats[stageKey];
  if (!stats) {
    return;
  }

  const bounded = Math.max(1, Math.min(3600, Number(durationSeconds) || 1));
  const nextSampleCount = Math.min(200, stats.samples + 1);
  const alpha = stats.samples === 0 ? 1 : 0.25;

  stats.avgSeconds = Math.round(
    stats.avgSeconds * (1 - alpha) + bounded * alpha,
  );
  stats.samples = nextSampleCount;
}

function getStageEstimatedSeconds(stageKey) {
  const stats = stageDurationStats[stageKey];
  if (stats && Number.isFinite(stats.avgSeconds) && stats.avgSeconds > 0) {
    return stats.avgSeconds;
  }

  return STAGE_DEFAULT_DURATIONS_SECONDS[stageKey] || 5;
}

function calculateDynamicEtaSeconds(job, now) {
  if (!job || job.status === "done" || job.status === "failed") {
    return 0;
  }

  if (job.status !== "running") {
    return STAGE_SEQUENCE.reduce(
      (sum, stageKey) => sum + getStageEstimatedSeconds(stageKey),
      0,
    );
  }

  const stageKey = String(job.stageKey || "");
  const stageIndex = STAGE_SEQUENCE.indexOf(stageKey);
  const stageElapsedSeconds = Math.max(
    0,
    Math.round((now - Number(job.stageStartedAt || now)) / 1000),
  );
  const elapsedSeconds = Math.max(
    1,
    Math.round((now - Number(job.startedAt || now)) / 1000),
  );

  const currentStageEstimate = getStageEstimatedSeconds(stageKey);
  const remainingCurrentStageSeconds =
    stageElapsedSeconds <= currentStageEstimate
      ? currentStageEstimate - stageElapsedSeconds
      : Math.max(2, Math.round(stageElapsedSeconds * 0.2));

  const remainingStageKeys =
    stageIndex >= 0 ? STAGE_SEQUENCE.slice(stageIndex + 1) : STAGE_SEQUENCE;

  const remainingStagesEstimate = remainingStageKeys.reduce(
    (sum, key) => sum + getStageEstimatedSeconds(key),
    0,
  );

  const etaByStages = Math.max(
    1,
    Math.round(remainingCurrentStageSeconds + remainingStagesEstimate),
  );

  const progress = Math.max(1, Math.min(99, Number(job.progress) || 1));
  const ratio = progress / 100;
  const etaByProgress = Math.max(
    1,
    Math.round((elapsedSeconds * (1 - ratio)) / ratio),
  );

  const blended = Math.round(etaByStages * 0.7 + etaByProgress * 0.3);
  return Math.max(1, blended);
}

function broadcastActiveJobStatuses() {
  for (const jobId of buildStatusSubscribers.keys()) {
    const job = buildJobs.get(jobId);
    if (!job) {
      continue;
    }

    if (job.status === "running" || job.status === "queued") {
      broadcastJobStatus(jobId);
    }
  }
}

function addBuildStatusSubscriber(jobId, socket) {
  const sockets = buildStatusSubscribers.get(jobId) || new Set();
  sockets.add(socket);
  buildStatusSubscribers.set(jobId, sockets);
}

function removeBuildStatusSubscriber(jobId, socket) {
  const sockets = buildStatusSubscribers.get(jobId);
  if (!sockets) {
    return;
  }

  sockets.delete(socket);
  if (sockets.size === 0) {
    buildStatusSubscribers.delete(jobId);
  }
}

function sendJobStatusToSocket(jobId, socket) {
  const job = buildJobs.get(jobId);
  if (!job || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({ success: true, job: formatJobPayload(job) }));
}

function broadcastJobStatus(jobId) {
  const sockets = buildStatusSubscribers.get(jobId);
  if (!sockets || sockets.size === 0) {
    return;
  }

  for (const socket of sockets) {
    sendJobStatusToSocket(jobId, socket);
  }
}

function closeJobStatusSubscribers(jobId) {
  const sockets = buildStatusSubscribers.get(jobId);
  if (!sockets) {
    return;
  }

  for (const socket of sockets) {
    try {
      socket.close(1000, "Job expired");
    } catch (_error) {
      // Ignore close errors.
    }
  }

  buildStatusSubscribers.delete(jobId);
}

function normalizeUrl(inputUrl) {
  if (!inputUrl) {
    throw new Error("URL is required.");
  }

  const prefixed = /^https?:\/\//i.test(inputUrl)
    ? inputUrl
    : `https://${inputUrl}`;

  const parsed = new URL(prefixed);
  if (!parsed.hostname) {
    throw new Error("Invalid hostname.");
  }

  return parsed.toString();
}

function deriveAppName(inputUrl) {
  const parsed = new URL(inputUrl);
  const host = parsed.hostname;
  const domainInfo = parseDomain(host);

  const subdomainParts = String(domainInfo.subdomain || "")
    .split(".")
    .filter(Boolean)
    .filter((part) => part.toLowerCase() !== "www");

  const domainParts = String(domainInfo.domainWithoutSuffix || host)
    .split(".")
    .filter(Boolean);

  const tokens = [...subdomainParts, ...domainParts]
    .map(toPascalToken)
    .filter(Boolean);

  const name = tokens.join("");

  return sanitizeDisplayName(name || "DesktopApp");
}

function toPascalToken(token) {
  const words = String(token)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  return words
    .map((word) => {
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function sanitizeDisplayName(name) {
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const limited = cleaned.slice(0, APP_NAME_MAX_LENGTH).trim();

  return limited || "DesktopApp";
}

function slugifyName(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const limited = slug.slice(0, APP_SLUG_MAX_LENGTH).replace(/-+$/g, "");

  return limited || "desktop-app";
}

async function writeIconFile(urlObj, assetsDir, customLogoBuffer = null) {
  const iconPath = path.join(assetsDir, "icon.ico");

  let sourceBuffer = customLogoBuffer;

  if (!sourceBuffer) {
    try {
      sourceBuffer = await fetchFaviconBuffer(urlObj, 12000);
    } catch (_error) {
      sourceBuffer = null;
    }
  }

  const icoBuffer = await buildSizedIco(sourceBuffer);

  await fs.writeFile(iconPath, icoBuffer);
}

async function buildSizedIco(sourceBuffer) {
  if (sourceBuffer) {
    if (isIco(sourceBuffer) && icoContains256(sourceBuffer)) {
      return sourceBuffer;
    }

    try {
      return await convertImageToIco256(sourceBuffer);
    } catch (_error) {
      // Fall through to generated fallback icon.
    }
  }

  const fallbackPng = createFallbackPng();
  return convertImageToIco256(fallbackPng);
}

async function convertImageToIco256(inputBuffer) {
  const png256 = await sharp(inputBuffer, { failOn: "none", animated: true })
    .resize(256, 256, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return pngToIco(png256);
}

async function fetchFaviconBuffer(urlObj, timeoutMs) {
  const host = urlObj.hostname;
  const protocol = urlObj.protocol || "https:";

  const candidateUrls = [
    `${protocol}//${host}/apple-touch-icon.png`,
    `${protocol}//${host}/android-chrome-512x512.png`,
    `${protocol}//${host}/android-chrome-256x256.png`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=256`,
    `${protocol}//${host}/favicon.ico`,
  ];

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await axios.get(candidateUrl, {
        responseType: "arraybuffer",
        timeout: timeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      const buffer = Buffer.from(response.data || []);
      if (buffer.length > 0) {
        return buffer;
      }
    } catch (_error) {
      // Try next candidate silently.
    }
  }

  throw new Error("Unable to fetch favicon.");
}

function detectMimeType(buffer) {
  if (isIco(buffer)) {
    return "image/x-icon";
  }

  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }

  if (
    buffer.length > 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46
  ) {
    return "image/gif";
  }

  return "application/octet-stream";
}

function isIco(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0x01 &&
    buffer[3] === 0x00
  );
}

function icoContains256(buffer) {
  if (!isIco(buffer) || buffer.length < 6) {
    return false;
  }

  const imageCount = buffer.readUInt16LE(4);
  const tableEnd = 6 + imageCount * 16;
  if (imageCount <= 0 || buffer.length < tableEnd) {
    return false;
  }

  for (let i = 0; i < imageCount; i += 1) {
    const entryOffset = 6 + i * 16;
    const width = buffer[entryOffset] === 0 ? 256 : buffer[entryOffset];
    const height =
      buffer[entryOffset + 1] === 0 ? 256 : buffer[entryOffset + 1];

    if (width >= 256 && height >= 256) {
      return true;
    }
  }

  return false;
}

function createFallbackPng() {
  const size = 256;
  const png = new PNG({ width: size, height: size });

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      const blend = (x + y) / (size * 2);
      png.data[idx] = Math.round(20 + 35 * blend);
      png.data[idx + 1] = Math.round(120 + 60 * blend);
      png.data[idx + 2] = Math.round(220 - 30 * blend);
      png.data[idx + 3] = 255;
    }
  }

  const center = size / 2;
  const radius = size * 0.26;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      if (Math.sqrt(dx * dx + dy * dy) <= radius) {
        const idx = (size * y + x) << 2;
        png.data[idx] = 245;
        png.data[idx + 1] = 250;
        png.data[idx + 2] = 255;
        png.data[idx + 3] = 255;
      }
    }
  }

  return PNG.sync.write(png);
}

async function writeElectronProject(jobDir, targetUrl, appName) {
  const escapedUrl = JSON.stringify(targetUrl);

  const mainJs = `const { app, BrowserWindow, shell } = require('electron');

const TARGET_URL = ${escapedUrl};

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    icon: 'assets/icon.ico',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(TARGET_URL);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
`;

  const packageJson = {
    name: slugifyName(appName),
    version: "1.0.0",
    private: true,
    description: `Desktop wrapper for ${targetUrl}`,
    author: "URL to EXE Builder",
    main: "main.js",
    scripts: {
      build: "electron-builder --win portable --publish never",
    },
    devDependencies: {
      electron: "^31.7.7",
      "electron-builder": "^24.13.3",
    },
    build: {
      appId: "com.generated.app",
      productName: appName,
      directories: {
        output: "dist",
      },
      files: ["main.js", "package.json", "assets/**/*"],
      asar: true,
      win: {
        target: "portable",
        icon: "assets/icon.ico",
      },
    },
  };

  await fs.writeFile(path.join(jobDir, "main.js"), mainJs, "utf8");
  await fs.writeFile(
    path.join(jobDir, "package.json"),
    JSON.stringify(packageJson, null, 2),
    "utf8",
  );
}

function runCommand(command, args, cwd, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const commandLine = [command, ...args.map(quoteShellArg)].join(" ");

  return new Promise((resolve, reject) => {
    exec(
      commandLine,
      {
        cwd,
        windowsHide: true,
        env: process.env,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        maxBuffer: 1024 * 1024 * 30,
      },
      (error, stdout, stderr) => {
        if (!error) {
          return resolve({
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          });
        }

        if (error.killed && timeoutMs > 0) {
          return reject(
            new Error(`Command timed out after ${timeoutMs}ms: ${commandLine}`),
          );
        }

        return reject(
          new Error(
            `Command failed: ${commandLine}\n${String(stdout || "")}\n${String(stderr || error.message || "")}`,
          ),
        );
      },
    );
  });
}

function quoteShellArg(value) {
  const text = String(value);
  if (!text) {
    return '""';
  }

  if (/[\s"&|<>^()]/.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }

  return text;
}

async function findBuiltExe(distDir) {
  if (!fssync.existsSync(distDir)) {
    return null;
  }

  const entries = await fs.readdir(distDir, { withFileTypes: true });
  const exeFiles = entries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
    )
    .map((entry) => path.join(distDir, entry.name));

  if (exeFiles.length === 0) {
    return null;
  }

  const portableExe = exeFiles.find((exePath) =>
    path.basename(exePath).toLowerCase().includes("portable"),
  );

  if (portableExe) {
    return portableExe;
  }

  const appExe = exeFiles.find(
    (exePath) => !path.basename(exePath).toLowerCase().includes("setup"),
  );

  if (appExe) {
    return appExe;
  }

  const setupExe = exeFiles.find((exePath) =>
    path.basename(exePath).toLowerCase().includes("setup"),
  );

  return setupExe || exeFiles[0];
}

function simplifyError(error) {
  const message = String(
    error && error.message ? error.message : error || "Unknown error",
  );

  if (message.length > 1000) {
    return `${message.slice(0, 1000)}...`;
  }

  return message;
}
