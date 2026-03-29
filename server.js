const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
const { PNG } = require("pngjs");
const pngToIco = require("png-to-ico");
const sharp = require("sharp");
const { parse: parseDomain } = require("tldts");

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const buildJobs = new Map();
const JOB_RETENTION_MS = 1000 * 60 * 60;

const BUILD_STAGES = {
  queued: { label: "Queued", progress: 1, etaSeconds: 230 },
  validating: { label: "Validating URL", progress: 5, etaSeconds: 220 },
  fetchingLogo: { label: "Fetching logo", progress: 15, etaSeconds: 210 },
  preparingProject: {
    label: "Preparing Electron project",
    progress: 28,
    etaSeconds: 200,
  },
  installingDeps: {
    label: "Installing dependencies",
    progress: 45,
    etaSeconds: 180,
  },
  packaging: { label: "Packaging Windows EXE", progress: 82, etaSeconds: 80 },
  finalizing: { label: "Finalizing output", progress: 96, etaSeconds: 20 },
  done: { label: "Completed", progress: 100, etaSeconds: 0 },
  failed: { label: "Failed", progress: 100, etaSeconds: 0 },
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

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

app.post("/build", (req, res) => {
  const { url, appName } = req.body || {};

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
    etaSeconds: BUILD_STAGES.queued.etaSeconds,
    startedAt,
    updatedAt: startedAt,
    appName: resolvedAppName,
    url: normalizedUrl,
    downloadUrl: null,
    error: null,
  });

  runBuildJob(jobId, normalizedUrl, resolvedAppName).catch(() => {
    // The job object is updated inside runBuildJob on error.
  });

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

  return res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      stageKey: job.stageKey,
      stageLabel: job.stageLabel,
      progress: job.progress,
      etaSeconds: job.etaSeconds,
      elapsedSeconds: Math.max(
        0,
        Math.round((Date.now() - job.startedAt) / 1000),
      ),
      appName: job.appName,
      downloadUrl: job.downloadUrl,
      error: job.error,
    },
  });
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

app.listen(PORT, async () => {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  setInterval(cleanupOldJobs, 1000 * 60 * 10).unref();

  console.log(`URL to EXE builder running at http://localhost:${PORT}`);
});

async function runBuildJob(jobId, normalizedUrl, appName) {
  const urlObj = new URL(normalizedUrl);
  const jobDir = path.join(TEMP_DIR, jobId);
  const assetsDir = path.join(jobDir, "assets");

  try {
    setJobStage(jobId, "validating");

    setJobStage(jobId, "fetchingLogo");
    await fs.mkdir(assetsDir, { recursive: true });
    await writeIconFile(urlObj, assetsDir);

    setJobStage(jobId, "preparingProject");
    await writeElectronProject(jobDir, normalizedUrl, appName);

    setJobStage(jobId, "installingDeps");
    await runCommand("npm", ["install", "--no-audit", "--no-fund"], jobDir, {
      timeoutMs: 1000 * 60 * 6,
    });

    setJobStage(jobId, "packaging");
    await runCommand(
      "npx",
      ["electron-builder", "--win", "nsis", "--publish", "never"],
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
      job.status = "done";
      job.stageKey = "done";
      job.stageLabel = BUILD_STAGES.done.label;
      job.progress = BUILD_STAGES.done.progress;
      job.etaSeconds = 0;
      job.downloadUrl = `/download/${encodeURIComponent(outputFileName)}`;
      job.updatedAt = Date.now();
    }
  } catch (error) {
    const job = buildJobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.stageKey = "failed";
      job.stageLabel = BUILD_STAGES.failed.label;
      job.progress = 100;
      job.etaSeconds = 0;
      job.error = simplifyError(error);
      job.updatedAt = Date.now();
    }
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

function setJobStage(jobId, stageKey) {
  const job = buildJobs.get(jobId);
  const stage = BUILD_STAGES[stageKey];

  if (!job || !stage) {
    return;
  }

  job.status = "running";
  job.stageKey = stageKey;
  job.stageLabel = stage.label;
  job.progress = stage.progress;
  job.etaSeconds = stage.etaSeconds;
  job.updatedAt = Date.now();
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [jobId, job] of buildJobs.entries()) {
    const finished = job.status === "done" || job.status === "failed";
    if (finished && now - job.updatedAt > JOB_RETENTION_MS) {
      buildJobs.delete(jobId);
    }
  }
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
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "DesktopApp";
}

function slugifyName(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "desktop-app";
}

async function writeIconFile(urlObj, assetsDir) {
  const iconPath = path.join(assetsDir, "icon.ico");

  let sourceBuffer = null;
  try {
    sourceBuffer = await fetchFaviconBuffer(urlObj, 12000);
  } catch (_error) {
    sourceBuffer = null;
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
    minWidth: 900,
    minHeight: 620,
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
      build: "electron-builder --win nsis --publish never",
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
        target: "nsis",
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
    exec(commandLine, {
      cwd,
      windowsHide: true,
      env: process.env,
      timeout: timeoutMs > 0 ? timeoutMs : undefined,
      maxBuffer: 1024 * 1024 * 30,
    }, (error, stdout, stderr) => {
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
    });
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
