#!/usr/bin/env node
/**
 * CipherTalk MCP — universal launcher for any MCP-compatible harness.
 *
 * Usage (stdio):
 *   node scripts/ciphertalk-mcp-universal.cjs
 *
 * Works in two modes:
 *   1. Dev mode  — if dist-electron/mcp.js exists (or after `npm run build:mcp`),
 *                  spawns Electron binary with ELECTRON_RUN_AS_NODE=1.
 *   2. Packaged  — if running alongside CipherTalk.exe / CipherTalk.app,
 *                  uses the packaged bootstrap.
 *
 * The MCP server auto-launches the CipherTalk desktop app when needed,
 * so the AI can query WeChat data without manual setup.
 */
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

// ── Packaged mode detection ──
const exeName = process.platform === "win32" ? "CipherTalk.exe" : "CipherTalk";
const packagedExe = path.join(rootDir, exeName);
const packagedBootstrap = path.join(rootDir, "ciphertalk-mcp-bootstrap.cjs");
const packagedAsar = path.join(rootDir, "resources", "app.asar");

function tryPackagedMode() {
  if (!fs.existsSync(packagedExe) || !fs.existsSync(packagedBootstrap)) return false;

  const entryUnpacked = path.join(rootDir, "resources", "app.asar.unpacked", "dist-electron", "mcp.js");
  const entryAsar = path.join(packagedAsar, "dist-electron", "mcp.js");

  let entry;
  if (fs.existsSync(entryUnpacked)) {
    entry = entryUnpacked;
  } else if (fs.existsSync(packagedAsar)) {
    entry = entryAsar;
  } else {
    return false;
  }

  const child = spawn(packagedExe, [packagedBootstrap], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CIPHERTALK_MCP_LAUNCHER: "universal-launcher",
      CIPHERTALK_MCP_ENTRY: entry,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  wireStdio(child);
  return true;
}

// ── Dev mode ──
function tryDevMode() {
  let electronBinary;
  try {
    electronBinary = require("electron");
    if (typeof electronBinary !== "string") {
      electronBinary = electronBinary.toString();
    }
  } catch {
    process.stderr.write("[CipherTalk MCP] electron package not found. Run: npm install\n");
    process.exit(1);
  }

  const entry = path.join(rootDir, "dist-electron", "mcp.js");
  if (!fs.existsSync(entry)) {
    process.stderr.write("[CipherTalk MCP] dist-electron/mcp.js not found, running build:mcp...\n");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const build = spawnSync(npmCmd, ["run", "build:mcp"], {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (build.status !== 0 || !fs.existsSync(entry)) {
      process.stderr.write("[CipherTalk MCP] build:mcp failed\n");
      process.exit(build.status ?? 1);
    }
  }

  const child = spawn(electronBinary, [entry], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CIPHERTALK_MCP_LAUNCHER: "universal-launcher",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  wireStdio(child);
  return true;
}

// ── Pipe stdio between this process and the child ──
function wireStdio(child) {
  if (process.stdin) process.stdin.pipe(child.stdin);
  if (child.stdout) child.stdout.pipe(process.stdout);
  if (child.stderr) child.stderr.pipe(process.stderr);

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    process.stderr.write(`[CipherTalk MCP] child process error: ${error}\n`);
    process.exit(1);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ── Main ──
if (!tryPackagedMode()) {
  tryDevMode();
}
