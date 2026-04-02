# Technical Documentation - URL to EXE Builder

## 1. Overview

URL to EXE Builder is a local Node.js application that converts a website URL into a branded Windows Electron EXE.

The system provides:

1. URL analysis and smart name suggestion.
2. Optional custom window title.
3. Optional custom logo upload.
4. Optional Automation Steps for simple post-load interactions.
5. Real-time build progress through WebSocket with polling fallback.
6. Final EXE download endpoint.

## 2. Technology Stack

1. Backend: Node.js, Express.
2. Build/Packaging: Electron, electron-builder.
3. Networking: axios.
4. Upload handling: multer.
5. Icon processing: sharp, png-to-ico, pngjs.
6. Domain parsing: tldts.
7. Realtime channel: ws (WebSocket).

## 3. Runtime Architecture

1. Client loads static UI from `public/`.
2. User submits build form to `POST /build`.
3. Server creates a build job in memory (`buildJobs` map).
4. Build runs in a temp workspace under `temp/<jobId>/`.
5. Job status is streamed via WebSocket (`/ws/build-status`) and available by HTTP polling (`/build-status/:jobId`).
6. Final EXE is copied to `output/`.
7. Client downloads EXE from `/download/:fileName`.

## 4. Project Structure

1. `server.js`: Backend server, build orchestration, API endpoints, WebSocket updates.
2. `public/index.html`: UI structure.
3. `public/styles.css`: UI theme/layout.
4. `public/script.js`: Client logic, realtime progress handling, form submission.
5. `setup.bat`: Dependency install/bootstrap script.
6. `start.bat`: Application start script.
7. `output/`: Generated EXE files.
8. `temp/`: Temporary per-job build workspace.

## 5. API Endpoints

### GET /health

Returns service health.

Response:

```json
{ "ok": true }
```

### GET /analyze?url=<url>

Validates URL and returns suggested values.

Response:

```json
{
  "success": true,
  "appName": "Youtube",
  "appTitle": "Youtube",
  "logoUrl": "/logo?url=https%3A%2F%2Fyoutube.com%2F"
}
```

### GET /logo?url=<url>

Returns detected site logo (or fallback image).

### POST /build

Creates a new build job.

Content type:
`multipart/form-data`

Fields:

1. `url` (required)
2. `appName` (optional)
3. `appTitle` (optional)
4. `logoFile` (optional upload)
5. `automationEnabled` (optional boolean string)
6. `automation` (optional JSON array string)

Response:

```json
{ "success": true, "jobId": "<job-id>" }
```

### GET /build-status/:jobId

Returns current job state.

Response shape:

```json
{
  "success": true,
  "job": {
    "id": "...",
    "status": "queued|running|done|failed",
    "stageKey": "...",
    "stageLabel": "...",
    "progress": 0,
    "etaSeconds": 0,
    "elapsedSeconds": 0,
    "appName": "...",
    "appTitle": "...",
    "hasCustomLogo": false,
    "downloadUrl": null,
    "error": null
  }
}
```

### GET /download/:fileName

Downloads generated EXE from `output/`.

## 6. WebSocket Realtime Channel

Endpoint:
`/ws/build-status?jobId=<job-id>`

Behavior:

1. Validates `jobId`.
2. Pushes structured status updates as JSON.
3. Frontend uses this as primary realtime source.
4. If socket fails, frontend falls back to HTTP polling every 1 second.

## 7. Build Pipeline Details

For each job:

1. Validate URL.
2. Resolve app name and app title.
3. Create temp project folder.
4. Resolve icon:

- Use uploaded logo if provided.
- Otherwise attempt website icon fetch.
- Convert/normalize icon to valid `.ico` with 256x256 support.

5. Generate Electron project files (`main.js`, `package.json`) in temp folder.
6. Install temp project dependencies.
7. Build Windows portable EXE via electron-builder.
8. Copy resulting EXE into `output/` with collision-safe naming.
9. Mark job done and expose download URL.

Automation notes:

1. Automation executes once after first page load.
2. Steps run sequentially.
3. Step delay defaults to 500ms (configurable per step).
4. Missing elements are ignored silently.
5. Supported step types: `type`, `click`, `radio`, `select`, `localStorage`, `wait`.

## 8. Naming and Title Rules

1. `appName` controls EXE naming and product name.
2. `appTitle` controls runtime window title/header behavior.
3. Sanitization and limits:

- App Name max: 80 chars.
- Window Title max: 120 chars.
- Slug max: 60 chars for output filename safety.

## 9. Persistent Runtime Window Title

Generated Electron app enforces title consistency by:

1. Setting BrowserWindow `title` to `appTitle`.
2. Re-applying title after page load/navigation.
3. Handling `page-title-updated` and preventing site overrides.
4. Updating `document.title` in the renderer context.

## 10. Dynamic ETA Model

ETA is computed on backend, not just a blind frontend timer.

It uses:

1. Stage sequence and progress checkpoints.
2. Per-stage default expected durations.
3. Stage duration sampling from completed jobs.
4. Blended estimate from stage timing and progress ratio.

Server pushes active status updates every second to keep ETA fresh.

## 11. Error Handling

1. Invalid URL: returns HTTP 400.
2. Upload size limit: returns clear error (max 8MB).
3. Build failures: captured and returned via job status (`failed` + `error`).
4. Missing download artifact: returns HTTP 404.
5. Favicon fetch failure: fallback icon generation.

## 12. Security and Safety Notes

1. File downloads use safe basename handling.
2. Uploaded files are handled in memory and sanitized through image processing.
3. Temporary job folders are cleaned after build.
4. Browser external links are opened via `shell.openExternal` and blocked from spawning in-app windows.

## 13. Operational Notes

1. Port default: `3000` (override with `PORT` env var).
2. Jobs are stored in memory and cleaned after retention window.
3. This project is intended for local use on Windows.

## 14. Batch Scripts

1. `setup.bat`:

- Checks npm availability.
- Runs `npm install`.
- Creates `output/` and `temp/` folders.

2. `start.bat`:

- Opens browser at `http://localhost:3000`.
- Runs `npm start`.

## 15. Detailed Code Explanation and Flow

# URL to EXE Builder - Code Explanation and Flow

## Project Overview

This application allows users to convert any website URL into a Windows desktop EXE using Electron. It provides a local UI where users can enter a URL, set app name/window title, upload a custom logo, add automation steps (click, type, select, localStorage, wait), and generate a downloadable EXE file.

## Flow Explanation

### 1. Frontend (public/ directory)

#### HTML Structure (index.html)

- Defines the UI layout with two main panes: input (left) and output/insights (right)
- Input pane contains form fields for URL, app name, window title, logo upload, and automation steps
- Output pane shows app preview, build progress bar, ETA/elapsed time, and stage list
- Includes status message area and download link (initially hidden)
- Links to styles.css and script.js

#### Styling (styles.css)

- Provides responsive design with CSS variables for colors
- Styles form elements, buttons, progress bar, status messages, and automation step cards
- Includes hover/active states and media queries for mobile
- Defines visual states for progress stages (done, active)

#### Frontend Logic (script.js)

- **Initialization**: Sets up DOM element references, constants for automation actions, and state variables
- **URL Analysis**:
  - On URL input change, debounced call to `/analyze` endpoint to get suggested app name and logo URL
  - Updates app name/title inputs if not manually edited by user
  - Updates logo preview with detected favicon
- **Automation Steps UI**:
  - Toggle to enable/disable automation panel
  - Dynamic step cards allowing users to add, remove, reorder steps
  - Each step has type selector (type, click, radio, select, localStorage, wait), selector/input/value/key fields, and delay
  - Input validation and sanitization for selectors, values, keys, and delays
- **Form Submission**:
  - Prevents default form submit, validates URL
  - Collects form data (URL, app name, appTitle, automation enabled/steps, logo file)
  - Sends multipart/form-data POST request to `/build` endpoint
  - Disables build button, resets UI for new build
- **Real-time Status Updates**:
  - Attempts WebSocket connection to `/ws/build-status?jobId=<id>` for real-time updates
  - Falls back to polling `/build-status/:jobId` every second if WebSocket fails
  - On status update:
    - Updates progress bar, stage label, ETA, elapsed time
    - Highlights current stage in stage list
    - Shows success/error message when build completes/fails
    - Shows download link when build succeeds
  - Cleans up WebSocket/polling when job completes or user navigates away

### 2. Backend (server.js)

#### Server Setup

- Express server with JSON body parsing (1MB limit) and static file serving from public/
- HTTP server wrapping Express for WebSocket support
- Constants for directories (temp, output, public), validation limits, build stages, and default durations
- WebSocket server (`/ws/build-status`) for real-time job status updates
- In-memory maps for tracking build jobs (`buildJobs`) and WebSocket subscribers (`buildStatusSubscribers`)

#### API Endpoints

- `GET /health`: Simple health check
- `GET /analyze`:
  - Normalizes URL, derives app name from hostname, generates logo URL
  - Returns suggested appName, appTitle, and logoUrl for frontend preview
- `GET /logo`:
  - Fetches favicon from URL (tries apple-touch-icon, android-chrome, Google favicon, favicon.ico)
  - Returns fallback generated icon if fetch fails
  - Caches response with appropriate headers
- `POST /build`:
  - Validates URL, sanitizes app name/title
  - Parses automation steps (if enabled) from JSON string
  - Creates unique jobId, initializes job object in `buildJobs` map
  - Starts `runBuildJob` asynchronously (does not await)
  - Returns 202 Accepted with jobId
- `GET /build-status/:jobId`:
  - Returns current job status and progress for polling fallback
- `GET /download/:fileName`:
  - Serves built EXE files from output directory
  - Prevents directory traversal with `path.basename`

#### WebSocket Status Updates

- On connection, extracts jobId from query params
- Validates job exists, adds socket to subscribers for that job
- Sends current job status immediately upon connection
- Removes subscriber on socket close/error

#### Build Job Processing (`runBuildJob`)

This is the core asynchronous function that handles EXE generation:

1. **Initialization**:
   - Creates job directory (`temp/<jobId>`) and assets subdirectory
   - Sets job stage to "validating"

2. **Stage 1: Validating**
   - Already done by endpoint validation, but marks stage complete

3. **Stage 2: Fetching Logo**
   - Creates assets directory
   - Calls `writeIconFile` to generate/icon.ico:
     - Uses custom logo if provided, otherwise fetches favicon via `fetchFaviconBuffer`
     - Converts source image to 256x256 ICO format using sharp and png-to-ico
     - Falls back to generated gradient icon if all fails
   - Writes icon.ico to assets directory

4. **Stage 3: Preparing Project**
   - Calls `writeElectronProject` to create Electron app:
     - Generates `main.js` with:
       - Electron app setup loading target URL in BrowserWindow
       - Automation step execution logic (runs after page load)
       - Window title enforcement
       - External link handling
     - Generates `package.json` with:
       - App metadata (name, version, description)
       - Electron and electron-builder as devDependencies
       - Build configuration for portable Windows EXE with icon
     - Writes both files to job directory

5. **Stage 4: Installing Dependencies**
   - Runs `npm install --no-audit --no-fund` in job directory
   - 6-minute timeout

6. **Stage 5: Packaging**
   - Runs `npx electron-builder --win portable --publish never` in job directory
   - 8-minute timeout
   - Produces distributable EXE in `jobDir/dist/`

7. **Stage 6: Finalizing**
   - Finds built EXE (prefers portable version, then app EXE, then setup EXE)
   - Generates unique output filename in output/ directory (appends suffix if duplicate)
   - Copies EXE from temp/dist/ to output/ final location
   - Updates job object with download URL and marks as "done"

8. **Error Handling**:
   - Any error during stages catches and marks job as "failed" with error message
   - Finally block cleans up job directory (temp/<jobId>)

#### Helper Functions

- **Job Status Management**:
  - `setJobStage`: Updates job progress, broadcasts to subscribers
  - `finalizeCurrentStage`: Records actual stage duration for adaptive ETAs
  - `recordStageDuration`: Updates rolling average of stage durations
  - `calculateDynamicEtaSeconds`: Blends stage-based and progress-based ETAs
  - `broadcastJobStatus`: Sends updates to all WebSocket subscribers for a job
- **Cleanup**:
  - `cleanupOldJobs`: Removes jobs older than 1 hour from memory
  - `broadcastActiveJobStatuses`: Periodically updates running/queued jobs
- **URL & Input Handling**:
  - `normalizeUrl`: Ensures URL has https:// prefix
  - `deriveAppName`: Converts hostname to PascalCase app name (strips www)
  - `sanitizeDisplayName`/`sanitizeWindowTitle`: Removes invalid filename chars, truncates
  - `parseAutomationSteps`: Validates and sanitizes automation step array
  - `sanitizeAutomationStep`: Normalizes step type, validates selector/value/key/delay
  - `slugifyName`: Converts app name to filesystem-safe slug
- **File Operations**:
  - `writeIconFile`, `buildSizedIco`, `convertImageToIco256`: Handle icon generation
  - `fetchFaviconBuffer`: Tries multiple CDN/sources for favicon
  - `detectMimeType`, `isIco`, `icoContains256`: Icon format detection
  - `createFallbackPng`: Generates gradient icon programmatically
  - `getAvailableOutputFileName`: Finds non-conflicting filename in output/
  - `findBuiltExe`: Locates EXE in electron-builder dist/ directory
  - `runCommand`: Wrapper for child_process.exec with timeout and quoting
  - `quoteShellArg`: Safely quotes arguments for shell commands
  - `simplifyError`: Truncates error messages for client safety

### 3. Data Flow Summary

**User Action → Build Initiation**:

1. User fills form and clicks "Generate EXE"
2. Frontend validates URL, collects form data
3. Frontend POSTs to `/build` with URL, appName, appTitle, automationEnabled, automation steps (JSON), and logo file (multipart)
4. Backend:
   - Creates jobId, initializes job object (queued status)
   - Starts `runBuildJob` async (returns immediately to client with 202)
   - Job progresses through stages, updating internal state

**Status Updates → UI Refresh**:

1. Backend:
   - After each stage transition, calls `setJobStage` → updates job object
   - Calls `broadcastJobStatus` → sends update to all WebSocket subscribers for that jobId
2. Frontend:
   - WebSocket receives message → parses job data → calls `handleJobUpdate`
   - `handleJobUpdate` → calls `renderBuildProgress` → updates:
     - Stage label, progress bar, percentage
     - ETA and elapsed time
     - Stage list highlighting (done/active)
     - Status message
     - Download link (when done)
   - If WebSocket fails, frontend polls `/build-status/:jobId` every second

**Completion → Download**:

1. When build succeeds:
   - Backend marks job as "done", sets downloadUrl
   - Broadcasts final status to subscribers
2. Frontend:
   - Receives done status → shows "Done. Your EXE is ready to download." success message
   - Unhides download link with href set to job.downloadUrl
   - User clicks link → browser GETs `/download/<filename>`
   - Backend serves EXE from output/ directory with appropriate headers
   - File download begins

### 4. Key Technologies

- **Frontend**: Vanilla JavaScript, HTML5, CSS3, Fetch API, WebSocket
- **Backend**: Node.js, Express, axios (HTTP client), sharp (image processing), png-to-ico (ICO generation), multer (file upload), ws (WebSocket), tldts (domain parsing)
- **Build Process**: Electron (app framework), electron-builder (EXE packaging)
- **Automation**: Browser JavaScript execution in Electron's renderer context (via `webContents.executeJavaScript`)

This architecture separates concerns: frontend handles user interaction and UI updates, backend manages the complex build process and job queuing, and WebSocket provides responsive progress feedback without polling overhead.

## 15. Core Code Explained

### 15.1 Build Job Lifecycle

The core build process runs in `runBuildJob()` (server.js:302). Here's the key flow:

```javascript
async function runBuildJob(
  jobId,
  normalizedUrl,
  appName,
  appTitle,
  customLogoBuffer,
  automationSteps,
) {
  const jobDir = path.join(TEMP_DIR, jobId);
  const assetsDir = path.join(jobDir, "assets");

  try {
    setJobStage(jobId, "validating"); // Mark stage start

    setJobStage(jobId, "fetchingLogo");
    await fs.mkdir(assetsDir, { recursive: true });
    await writeIconFile(urlObj, assetsDir, customLogoBuffer); // Generate icon.ico

    setJobStage(jobId, "preparingProject");
    await writeElectronProject(
      jobDir,
      normalizedUrl,
      appName,
      appTitle,
      automationSteps,
    ); // Create Electron app

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
    // ... copy to output/ and mark job as done
  } catch (error) {
    // Handle error, mark job as failed
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {}); // Cleanup
  }
}
```

### 15.2 Electron Project Generation

The `writeElectronProject()` function (server.js:1080) creates two critical files:

**main.js** (simplified):

```javascript
const { app, BrowserWindow, shell } = require("electron");

const TARGET_URL = "https://example.com"; // Injected from build params
const APP_TITLE = "My App";
const AUTOMATION_STEPS = [
  /* automation steps array */
];

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: APP_TITLE,
    icon: "assets/icon.ico",
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  win.webContents.on("did-finish-load", () => {
    // Execute automation steps after page loads
    runAutomation(win).catch(() => {});
  });

  win.loadURL(TARGET_URL);
}
```

**package.json**:

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "private": true,
  "main": "main.js",
  "devDependencies": {
    "electron": "^31.7.7",
    "electron-builder": "^24.13.3"
  },
  "build": {
    "appId": "com.generated.app",
    "productName": "My App",
    "files": ["main.js", "package.json", "assets/**/*"],
    "asar": true,
    "win": {
      "target": "portable",
      "icon": "assets/icon.ico"
    }
  }
}
```

### 15.3 Automation Step Execution

Automation steps run in the Electron renderer context via `webContents.executeJavaScript()`:

```javascript
async function runRendererStep(win, step) {
  const script = [
    "(() => {",
    "  const step = " + JSON.stringify(step) + ";",
    "  const selector = typeof step.selector === 'string' ? step.selector : '';",
    "  const value = step.value == null ? '' : String(step.value);",
    "  const key = typeof step.key === 'string' ? step.key : '';",
    "  const getElement = () => {",
    "    if (!selector) return null;",
    "    try { return document.querySelector(selector); }",
    "    catch (_) { return null; }",
    "  };",
    "  switch (step.type) {",
    "    case 'type': {",
    "      const element = getElement();",
    "      if (!element) return;",
    "      element.value = value;",
    "      element.dispatchEvent(new Event('input', { bubbles: true }));",
    "      element.dispatchEvent(new Event('change', { bubbles: true }));",
    "      return;",
    "    }",
    "    case 'click':",
    "    case 'radio': {",
    "      const element = getElement();",
    "      if (!element || typeof element.click !== 'function') return;",
    "      element.click();",
    "      return;",
    "    }",
    "    // ... other step types",
    "  }",
    "})();",
  ].join("\n");

  await win.webContents.executeJavaScript(script, true).catch(() => {});
}
```

### 15.4 WebSocket Status Updates

Real-time progress uses WebSocket with HTTP polling fallback:

**Server-side (server.js:98)**:

```javascript
buildStatusSocketServer.on("connection", (socket, request) => {
  let jobId = "";
  try {
    const parsedUrl = new URL(String(request.url || ""), "http://localhost");
    jobId = String(parsedUrl.searchParams.get("jobId") || "").trim();
  } catch (_error) {
    jobId = "";
  }

  if (!jobId || !buildJobs.has(jobId)) {
    socket.close(1008, "Missing or invalid jobId");
    return;
  }

  addBuildStatusSubscriber(jobId, socket);
  sendJobStatusToSocket(jobId, socket); // Immediate status push

  socket.on("close", () => removeBuildStatusSubscriber(jobId, socket));
  socket.on("error", () => removeBuildStatusSubscriber(jobId, socket));
});
```

**Client-side (public/script.js:639)**:

```javascript
function startBuildStatusUpdates(jobId) {
  stopRealtimeUpdates();
  activeJobId = jobId;

  const wsEnabled = connectStatusSocket(jobId);
  if (!wsEnabled) {
    startStatusPolling(jobId); // Fallback to HTTP polling
  }
}

function connectStatusSocket(jobId) {
  // ... WebSocket setup
  statusSocket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.success && data.job) {
        handleJobUpdate(data.job); // Update UI
      }
    } catch (_error) {}
  });
  // ... error/close handlers trigger polling fallback
}
```

### 15.5 Dynamic ETA Calculation

ETA combines stage-based and progress-based estimates:

```javascript
function calculateDynamicEtaSeconds(job, now) {
  if (job.status === "done" || job.status === "failed") return 0;

  // Stage-based ETA: sum of remaining stage durations
  const remainingStagesEstimate = remainingStageKeys.reduce(
    (sum, key) => sum + getStageEstimatedSeconds(key),
    0,
  );

  // Progress-based ETA: extrapolate from elapsed time and progress
  const elapsedSeconds = Math.round((now - job.startedAt) / 1000);
  const progress = Math.max(1, Math.min(99, job.progress));
  const etaByProgress = Math.round(
    (elapsedSeconds * (100 - progress)) / progress,
  );

  // Blend both estimates (70% stage-based, 30% progress-based)
  return Math.round(etaByStages * 0.7 + etaByProgress * 0.3);
}
```
