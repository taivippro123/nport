#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const nportEntry = path.join(rootDir, 'dist', 'index.js');

const RESTART_INTERVAL_MS = 3 * 60 * 60 * 1000 + 55 * 60 * 1000; // 3h55m
const WARNING_WINDOW_MINUTES = 5;
const SHUTDOWN_GRACE_MS = 20_000;
const RETRY_DELAY_MS = 10_000;
const HEALTHCHECK_URL = 'https://bookfet.nport.link/api/health/test-OK';
const HEALTHCHECK_INTERVAL_MS = 30_000;
const HEALTHCHECK_TIMEOUT_MS = 8_000;
const HEALTHCHECK_WARMUP_MS = 90_000;
const MAX_HEALTHCHECK_FAILURES = 3;

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('-h') || rawArgs.includes('--help') || rawArgs.length === 0) {
  console.log(`\nNPort Keepalive (local tool)\n`);
  console.log('Usage:');
  console.log('  npm run keepalive -- <port> -s <subdomain> [nport options]');
  console.log('');
  console.log('Example:');
  console.log('  npm run keepalive -- 3000 -s myapp -b https://api.your-domain.com');
  console.log('');
  console.log('Behavior:');
  console.log('  - Starts nport with your args');
  console.log(`  - Calls health API: ${HEALTHCHECK_URL}`);
  console.log(`  - Skips healthcheck for ${Math.floor(HEALTHCHECK_WARMUP_MS / 1000)}s after startup`);
  console.log(`  - Restarts only after ${MAX_HEALTHCHECK_FAILURES} consecutive failed healthchecks`);
  console.log('  - Counts down from 3h55m');
  console.log('  - Warns in the last 5 minutes');
  console.log('  - Sends SIGINT (like Ctrl+C) to cleanup');
  console.log('  - Restarts nport with the same args in a loop\n');
  process.exit(0);
}

const hasSubdomain = rawArgs.some((arg, index) => {
  if (arg === '-s' || arg === '--subdomain') {
    return !!rawArgs[index + 1];
  }
  return arg.startsWith('--subdomain=');
});

if (!hasSubdomain) {
  console.error('❌ Missing subdomain. Use -s <name> or --subdomain <name> to keep the same URL.');
  process.exit(1);
}

let child = null;
let countdownTimer = null;
let restartTimer = null;
let healthcheckTimer = null;
let isStopping = false;
let isRestarting = false;
let isHealthcheckRunning = false;
let lastPrintedMinute = -1;
let cycleStartedAt = 0;
let healthFailStreak = 0;

function fmtMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clearTimers() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (healthcheckTimer) {
    clearInterval(healthcheckTimer);
    healthcheckTimer = null;
  }
}

async function healthCheckAndRestartIfNeeded() {
  if (isStopping || isRestarting || isHealthcheckRunning) {
    return;
  }

  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  const uptimeMs = Date.now() - cycleStartedAt;
  if (uptimeMs < HEALTHCHECK_WARMUP_MS) {
    return;
  }

  isHealthcheckRunning = true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(HEALTHCHECK_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const isHealthy = response.ok && payload?.status === 'OK';

    if (isHealthy) {
      if (healthFailStreak > 0) {
        console.log('✅ Healthcheck recovered. Keepalive continues normally.');
      }
      healthFailStreak = 0;
      return;
    }

    healthFailStreak += 1;
    console.log(
      `\n⚠️ Healthcheck failed (${healthFailStreak}/${MAX_HEALTHCHECK_FAILURES}) at ${HEALTHCHECK_URL}.`
    );

    if (healthFailStreak >= MAX_HEALTHCHECK_FAILURES) {
      console.log('♻️ Healthcheck failed repeatedly, restarting tunnel now...');
      isRestarting = true;
      clearTimers();
      await gracefulStopChild();
      scheduleRestart(1_000);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    healthFailStreak += 1;
    console.log(
      `\n⚠️ Healthcheck error (${healthFailStreak}/${MAX_HEALTHCHECK_FAILURES}): ${message}`
    );

    if (healthFailStreak >= MAX_HEALTHCHECK_FAILURES) {
      console.log('♻️ Healthcheck error repeated, restarting tunnel now...');
      isRestarting = true;
      clearTimers();
      await gracefulStopChild();
      scheduleRestart(1_000);
    }
  } finally {
    isHealthcheckRunning = false;
  }
}

function scheduleRestart(delayMs = 0) {
  if (isStopping) {
    return;
  }

  restartTimer = setTimeout(() => {
    startCycle();
  }, delayMs);
}

async function gracefulStopChild() {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  console.log('\n🛑 Sending SIGINT to nport (same as Ctrl+C) ...');
  child.kill('SIGINT');

  const exited = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

  if (!exited && child && child.exitCode === null) {
    console.log('⚠️ Graceful shutdown timeout, sending SIGTERM...');
    child.kill('SIGTERM');
  }
}

function startCycle() {
  if (isStopping) {
    return;
  }

  clearTimers();
  isRestarting = false;
  lastPrintedMinute = -1;
  cycleStartedAt = Date.now();
  healthFailStreak = 0;

  console.log('\n============================================================');
  console.log(`🚀 Starting nport: node dist/index.js ${rawArgs.join(' ')}`);
  console.log('============================================================\n');

  child = spawn(process.execPath, [nportEntry, ...rawArgs], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  const cycleStart = cycleStartedAt;
  const cycleEnd = cycleStart + RESTART_INTERVAL_MS;

  console.log(`⏱️ Auto-restart in 3h55m (at ${new Date(cycleEnd).toLocaleString()})`);

  healthCheckAndRestartIfNeeded();
  healthcheckTimer = setInterval(() => {
    healthCheckAndRestartIfNeeded();
  }, HEALTHCHECK_INTERVAL_MS);

  countdownTimer = setInterval(async () => {
    const remainingMs = cycleEnd - Date.now();
    const remainingMinutes = Math.ceil(remainingMs / 60_000);

    if (remainingMinutes !== lastPrintedMinute) {
      const shouldPrint =
        remainingMinutes <= WARNING_WINDOW_MINUTES ||
        remainingMinutes % 30 === 0 ||
        remainingMinutes === 235;

      if (shouldPrint && remainingMinutes >= 0) {
        if (remainingMinutes <= WARNING_WINDOW_MINUTES && remainingMinutes > 0) {
          console.log(`⏳ Còn ${remainingMinutes} phút trước khi restart tunnel...`);
        } else {
          console.log(`⏳ Countdown: ${fmtMs(remainingMs)}`);
        }
      }

      lastPrintedMinute = remainingMinutes;
    }

    if (remainingMs <= 0 && !isRestarting) {
      isRestarting = true;
      clearTimers();
      console.log('\n♻️ Reaching 3h55m, restarting tunnel to avoid 4h timeout...');
      await gracefulStopChild();
      scheduleRestart(3_000);
    }
  }, 1000);

  child.on('exit', (code, signal) => {
    clearTimers();

    if (isStopping) {
      return;
    }

    if (isRestarting) {
      console.log(`✅ Tunnel closed for rotation (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
      return;
    }

    console.log(`⚠️ nport exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Retrying in 10s...`);
    scheduleRestart(RETRY_DELAY_MS);
  });
}

async function shutdownWrapper(signalName) {
  if (isStopping) {
    return;
  }

  isStopping = true;
  clearTimers();
  console.log(`\n${signalName} received, stopping keepalive wrapper...`);
  await gracefulStopChild();
  process.exit(0);
}

process.on('SIGINT', () => shutdownWrapper('SIGINT'));
process.on('SIGTERM', () => shutdownWrapper('SIGTERM'));

startCycle();
