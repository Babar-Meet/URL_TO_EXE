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
