#!/usr/bin/env bun
/**
 * QMD Daemon Manager - Cross-platform service management
 *
 * Supports:
 *   - macOS: launchd (LaunchAgents)
 *   - Linux: systemd (user services)
 *   - Windows: Windows Service Control Manager (SCM)
 *
 * Usage:
 *   qmd server daemon install   # Install as system service
 *   qmd server daemon uninstall # Remove service
 *   qmd server daemon start     # Start service
 *   qmd server daemon stop      # Stop service
 *   qmd server daemon status    # Check service status
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { $ } from "bun";

// =============================================================================
// Platform Detection
// =============================================================================

export type Platform = "macos" | "linux" | "windows" | "unknown";

export function getPlatform(): Platform {
  const platform = process.platform;
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "unknown";
}

// =============================================================================
// Configuration
// =============================================================================

const SERVICE_NAME = "qmd-server";
const SERVICE_DISPLAY_NAME = "QMD Server";
const SERVICE_DESCRIPTION = "QMD Socket Server for UI integration";

function getConfigPaths(platform: Platform) {
  const home = homedir();

  switch (platform) {
    case "macos":
      return {
        serviceDir: join(home, "Library", "LaunchAgents"),
        serviceFile: join(home, "Library", "LaunchAgents", `com.qmd.server.plist`),
        logDir: join(home, "Library", "Logs", "qmd"),
        pidFile: join(home, ".cache", "qmd", "daemon.pid"),
      };

    case "linux":
      return {
        serviceDir: join(home, ".config", "systemd", "user"),
        serviceFile: join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
        logDir: join(home, ".local", "share", "qmd", "logs"),
        pidFile: join(home, ".cache", "qmd", "daemon.pid"),
      };

    case "windows":
      return {
        serviceDir: join(home, "qmd"),
        serviceFile: join(home, "qmd", `${SERVICE_NAME}.xml`),
        logDir: join(home, "qmd", "logs"),
        pidFile: join(home, "qmd", "daemon.pid"),
      };

    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

// =============================================================================
// macOS: launchd
// =============================================================================

function generateLaunchdPlist(qmdPath: string, logDir: string): string {
  const logPath = join(logDir, "server.log");
  const errorLogPath = join(logDir, "server.error.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qmd.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${qmdPath}</string>
        <string>server</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${errorLogPath}</string>
    <key>WorkingDirectory</key>
    <string>${homedir()}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>`;
}

async function installMacOS(): Promise<boolean> {
  const paths = getConfigPaths("macos");
  const qmdPath = await findQMDPath();

  if (!qmdPath) {
    console.error("Error: Could not find qmd executable. Make sure it's installed.");
    return false;
  }

  // Ensure directories exist
  if (!existsSync(paths.serviceDir)) {
    mkdirSync(paths.serviceDir, { recursive: true });
  }
  if (!existsSync(paths.logDir)) {
    mkdirSync(paths.logDir, { recursive: true });
  }

  // Generate and write plist
  const plist = generateLaunchdPlist(qmdPath, paths.logDir);
  writeFileSync(paths.serviceFile, plist);

  // Load the service
  try {
    await $`launchctl load ${paths.serviceFile}`;
    console.log("✓ QMD server installed as launchd service");
    console.log(`  Service file: ${paths.serviceFile}`);
    console.log(`  Logs: ${paths.logDir}`);
    return true;
  } catch (error) {
    console.error("Error loading launchd service:", error);
    return false;
  }
}

async function uninstallMacOS(): Promise<boolean> {
  const paths = getConfigPaths("macos");

  if (!existsSync(paths.serviceFile)) {
    console.log("Service not installed");
    return true;
  }

  try {
    // Unload service
    await $`launchctl unload ${paths.serviceFile}`;
    // Remove plist
    unlinkSync(paths.serviceFile);
    console.log("✓ QMD server uninstalled");
    return true;
  } catch (error) {
    console.error("Error uninstalling service:", error);
    return false;
  }
}

async function startMacOS(): Promise<boolean> {
  const paths = getConfigPaths("macos");

  if (!existsSync(paths.serviceFile)) {
    console.error("Service not installed. Run: qmd server daemon install");
    return false;
  }

  try {
    await $`launchctl start com.qmd.server`;
    console.log("✓ QMD server started");
    return true;
  } catch (error) {
    console.error("Error starting service:", error);
    return false;
  }
}

async function stopMacOS(): Promise<boolean> {
  try {
    await $`launchctl stop com.qmd.server`;
    console.log("✓ QMD server stopped");
    return true;
  } catch (error) {
    console.error("Error stopping service:", error);
    return false;
  }
}

async function statusMacOS(): Promise<boolean> {
  const paths = getConfigPaths("macos");

  if (!existsSync(paths.serviceFile)) {
    console.log("○ Service not installed");
    return false;
  }

  try {
    const result = await $`launchctl list | grep com.qmd.server`.quiet();
    if (result.exitCode === 0) {
      console.log("● QMD server is running");
      return true;
    } else {
      console.log("○ QMD server is stopped");
      return false;
    }
  } catch {
    console.log("○ QMD server is stopped");
    return false;
  }
}

// =============================================================================
// Linux: systemd
// =============================================================================

function generateSystemdService(qmdPath: string, logDir: string): string {
  const logPath = join(logDir, "server.log");
  const errorLogPath = join(logDir, "server.error.log");

  return `[Unit]
Description=${SERVICE_DESCRIPTION}
After=network.target

[Service]
Type=simple
ExecStart=${qmdPath} server start
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${errorLogPath}
WorkingDirectory=${homedir()}

[Install]
WantedBy=default.target`;
}

async function installLinux(): Promise<boolean> {
  const paths = getConfigPaths("linux");
  const qmdPath = await findQMDPath();

  if (!qmdPath) {
    console.error("Error: Could not find qmd executable. Make sure it's installed.");
    return false;
  }

  // Ensure directories exist
  if (!existsSync(paths.serviceDir)) {
    mkdirSync(paths.serviceDir, { recursive: true });
  }
  if (!existsSync(paths.logDir)) {
    mkdirSync(paths.logDir, { recursive: true });
  }

  // Generate and write service file
  const service = generateSystemdService(qmdPath, paths.logDir);
  writeFileSync(paths.serviceFile, service);

  // Reload systemd and enable service
  try {
    await $`systemctl --user daemon-reload`;
    await $`systemctl --user enable ${SERVICE_NAME}`;
    console.log("✓ QMD server installed as systemd service");
    console.log(`  Service file: ${paths.serviceFile}`);
    console.log(`  Logs: ${paths.logDir}`);
    console.log("\nTo start the service, run:");
    console.log("  qmd server daemon start");
    return true;
  } catch (error) {
    console.error("Error installing systemd service:", error);
    return false;
  }
}

async function uninstallLinux(): Promise<boolean> {
  const paths = getConfigPaths("linux");

  if (!existsSync(paths.serviceFile)) {
    console.log("Service not installed");
    return true;
  }

  try {
    // Stop and disable service
    await $`systemctl --user stop ${SERVICE_NAME}`.quiet();
    await $`systemctl --user disable ${SERVICE_NAME}`;
    // Remove service file
    unlinkSync(paths.serviceFile);
    await $`systemctl --user daemon-reload`;
    console.log("✓ QMD server uninstalled");
    return true;
  } catch (error) {
    console.error("Error uninstalling service:", error);
    return false;
  }
}

async function startLinux(): Promise<boolean> {
  try {
    await $`systemctl --user start ${SERVICE_NAME}`;
    console.log("✓ QMD server started");
    return true;
  } catch (error) {
    console.error("Error starting service:", error);
    return false;
  }
}

async function stopLinux(): Promise<boolean> {
  try {
    await $`systemctl --user stop ${SERVICE_NAME}`;
    console.log("✓ QMD server stopped");
    return true;
  } catch (error) {
    console.error("Error stopping service:", error);
    return false;
  }
}

async function statusLinux(): Promise<boolean> {
  const paths = getConfigPaths("linux");

  if (!existsSync(paths.serviceFile)) {
    console.log("○ Service not installed");
    return false;
  }

  try {
    const result = await $`systemctl --user is-active ${SERVICE_NAME}`.quiet();
    if (result.stdout.toString().trim() === "active") {
      console.log("● QMD server is running");
      return true;
    } else {
      console.log("○ QMD server is stopped");
      return false;
    }
  } catch {
    console.log("○ QMD server is stopped");
    return false;
  }
}

// =============================================================================
// Windows: Task Scheduler (simpler than Windows Service)
// =============================================================================

async function installWindows(): Promise<boolean> {
  const paths = getConfigPaths("windows");
  const qmdPath = await findQMDPath();

  if (!qmdPath) {
    console.error("Error: Could not find qmd executable. Make sure it's installed.");
    return false;
  }

  // Ensure directories exist
  if (!existsSync(paths.serviceDir)) {
    mkdirSync(paths.serviceDir, { recursive: true });
  }
  if (!existsSync(paths.logDir)) {
    mkdirSync(paths.logDir, { recursive: true });
  }

  const logPath = join(paths.logDir, "server.log");

  try {
    // Create scheduled task that runs at logon
    await $`schtasks /create /tn "${SERVICE_NAME}" /tr "'${qmdPath}' server start" /sc onlogon /rl highest /f`;
    console.log("✓ QMD server installed as scheduled task");
    console.log(`  Logs: ${paths.logDir}`);
    console.log("\nTo start the service, run:");
    console.log("  qmd server daemon start");
    return true;
  } catch (error) {
    console.error("Error installing Windows task:", error);
    return false;
  }
}

async function uninstallWindows(): Promise<boolean> {
  try {
    await $`schtasks /delete /tn "${SERVICE_NAME}" /f`.quiet();
    console.log("✓ QMD server uninstalled");
    return true;
  } catch (error) {
    console.error("Error uninstalling task:", error);
    return false;
  }
}

async function startWindows(): Promise<boolean> {
  try {
    await $`schtasks /run /tn "${SERVICE_NAME}"`;
    console.log("✓ QMD server started");
    return true;
  } catch (error) {
    console.error("Error starting task:", error);
    return false;
  }
}

async function stopWindows(): Promise<boolean> {
  try {
    await $`schtasks /end /tn "${SERVICE_NAME}"`;
    console.log("✓ QMD server stopped");
    return true;
  } catch (error) {
    console.error("Error stopping task:", error);
    return false;
  }
}

async function statusWindows(): Promise<boolean> {
  try {
    const result = await $`schtasks /query /tn "${SERVICE_NAME}" /fo list`.quiet();
    const output = result.stdout.toString();
    if (output.includes("Running")) {
      console.log("● QMD server is running");
      return true;
    } else {
      console.log("○ QMD server is stopped");
      return false;
    }
  } catch {
    console.log("○ Service not installed");
    return false;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

async function findQMDPath(): Promise<string | null> {
  // Try to find qmd in common locations
  const attempts = [
    "qmd", // If in PATH
    join(homedir(), ".bun", "bin", "qmd"),
    "/usr/local/bin/qmd",
    "/usr/bin/qmd",
  ];

  for (const path of attempts) {
    try {
      const result = await $`which ${path}`.quiet();
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
    } catch {
      // Try next
    }
  }

  return null;
}

// =============================================================================
// Public API
// =============================================================================

export async function installDaemon(): Promise<boolean> {
  const platform = getPlatform();

  switch (platform) {
    case "macos":
      return installMacOS();
    case "linux":
      return installLinux();
    case "windows":
      return installWindows();
    default:
      console.error(`Daemon mode not supported on ${platform}`);
      return false;
  }
}

export async function uninstallDaemon(): Promise<boolean> {
  const platform = getPlatform();

  switch (platform) {
    case "macos":
      return uninstallMacOS();
    case "linux":
      return uninstallLinux();
    case "windows":
      return uninstallWindows();
    default:
      console.error(`Daemon mode not supported on ${platform}`);
      return false;
  }
}

export async function startDaemon(): Promise<boolean> {
  const platform = getPlatform();

  switch (platform) {
    case "macos":
      return startMacOS();
    case "linux":
      return startLinux();
    case "windows":
      return startWindows();
    default:
      console.error(`Daemon mode not supported on ${platform}`);
      return false;
  }
}

export async function stopDaemon(): Promise<boolean> {
  const platform = getPlatform();

  switch (platform) {
    case "macos":
      return stopMacOS();
    case "linux":
      return stopLinux();
    case "windows":
      return stopWindows();
    default:
      console.error(`Daemon mode not supported on ${platform}`);
      return false;
  }
}

export async function statusDaemon(): Promise<boolean> {
  const platform = getPlatform();

  switch (platform) {
    case "macos":
      return statusMacOS();
    case "linux":
      return statusLinux();
    case "windows":
      return statusWindows();
    default:
      console.error(`Daemon mode not supported on ${platform}`);
      return false;
  }
}

export function getPlatformName(): string {
  const platform = getPlatform();
  switch (platform) {
    case "macos":
      return "macOS (launchd)";
    case "linux":
      return "Linux (systemd)";
    case "windows":
      return "Windows (Task Scheduler)";
    default:
      return "Unknown";
  }
}
