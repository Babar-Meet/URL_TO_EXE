# URL to EXE Builder

Convert any website URL into a Windows desktop EXE using Electron.

## What This Tool Does

This project gives you a local UI where you can:

1. Enter a website URL.
2. Set an app name (EXE name).
3. Set a window title.
4. Optionally upload a custom logo.
5. Optionally add automation steps (click, type, select, localStorage, wait).
6. Build and download a Windows EXE.

## Requirements

1. Windows OS.
2. Node.js LTS (includes npm).

## Setup (One Time)

1. Get the project (ZIP or clone):

```bash
git clone https://github.com/Babar-Meet/URL_TO_EXE
```

2. Go to the project folder and run:

```bat
setup.bat
```

This installs all dependencies and prepares output/temp folders.

## Start the Builder UI

Run:

```bat
start.bat
```

Then open:

```text
http://localhost:3000
```

## How to Make an EXE (Step by Step)

1. Enter Website URL.
2. Enter App Name (optional, auto-suggested from URL).
3. Enter Window Title (optional).
4. Upload logo if needed (optional).
5. If you need post-load actions, enable Automation Steps.
6. Click Generate EXE.
7. Wait for build stages to complete.
8. Click Download EXE.

Generated EXE files are stored in the output folder.

## Automation Steps Guide

Each step has:

1. Action Type
2. Selector (for click/type/radio/select)
3. Value (for type/select/wait/localStorage)
4. Key (for localStorage)
5. Delay (ms) between steps

### Selector Input Rule

You can enter either:

1. Raw element id (example: rblRole_1)
2. Full CSS selector (example: #rblRole_1, .btn-login, [name="username"])

Plain ids are automatically treated as element IDs, so you do not need to add # manually.

### Example Login Automation

If your page has ids:

1. rblRole_1 (radio)
2. txtUsername
3. txtPassword
4. btnLogin

Create steps like this:

1. Select Radio Button, selector: rblRole_1, delay: 2000
2. Type Text, selector: txtUsername, value: meed, delay: 2000
3. Type Text, selector: txtPassword, value: meet, delay: 2000
4. Click Element, selector: btnLogin

## Troubleshooting

1. If a step does not run, verify selector/id in browser DevTools.
2. Add more delay (for example 2000 ms) if page elements load late.
3. If build fails, check the error shown in the status panel.
4. If needed, delete temp build folders and retry.
