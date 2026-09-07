import type { Express } from "express";
import { createServer, type Server } from "http";
import proxy from "express-http-proxy";
import { spawn } from "child_process";
import path from "path";
import { resolvePython } from "./python";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Start Python backend
  const python = resolvePython();
  const flaskEntry = path.join("backend", "main.py");
  console.log(`Starting Python backend (${python.join(" ")} ${flaskEntry})...`);
  const flaskPort = process.env.FLASK_PORT || "3000";
  const [pythonCmd, ...pythonArgs] = python;
  const pythonProcess = spawn(pythonCmd, [...pythonArgs, flaskEntry], {
    stdio: "inherit",
    env: {
      ...process.env,
      FLASK_PORT: flaskPort,
      // Python block-buffers stdout when it isn't a terminal, so under the
      // launcher (which pipes output to tag it) print() diagnostics would sit
      // in the buffer instead of appearing. Keep them live.
      PYTHONUNBUFFERED: "1",
    },
  });

  pythonProcess.on('error', (err) => {
    console.error('Failed to start Python backend:', err);
  });

  // Don't leave the Flask child (and the detector it may have spawned) running
  // after Express exits. Windows has no POSIX signals, so kill() is the only
  // portable way to stop it.
  const stopPython = () => {
    if (pythonProcess.exitCode === null) pythonProcess.kill();
  };
  process.on("exit", stopPython);
  process.on("SIGINT", () => { stopPython(); process.exit(0); });
  process.on("SIGTERM", () => { stopPython(); process.exit(0); });

  // Proxy API requests to Python backend.
  // 127.0.0.1, not "localhost": on Windows that name resolves to IPv6 ::1
  // first, and Flask binds IPv4 only, so every request pays a failover delay
  // (~2s on some setups) before it connects.
  const pythonProxy = proxy(`http://127.0.0.1:${flaskPort}`);

  app.get("/alerts", pythonProxy);
  app.post("/receive-alert", pythonProxy);
  app.get("/device-config", pythonProxy);

  // Auth endpoints (phone OTP) are handled by the Python backend too
  app.post("/auth/request-code", pythonProxy);
  app.post("/auth/verify", pythonProxy);
  app.get("/auth/me", pythonProxy);
  app.post("/auth/logout", pythonProxy);

  // Demo account: one-click login and simulated detections, for a checkout
  // that has no SMS credentials and no camera.
  app.get("/auth/demo-status", pythonProxy);
  app.post("/auth/demo", pythonProxy);
  app.post("/demo/alert", pythonProxy);
  app.post("/demo/age", pythonProxy);

  // Account settings + alert escalation
  app.get("/account", pythonProxy);
  app.post("/account/name", pythonProxy);
  app.post("/account/contacts", pythonProxy);
  app.post("/account/location", pythonProxy);
  app.post("/account/teens-mature", pythonProxy);
  app.post("/account/phone/request", pythonProxy);
  app.post("/account/phone/verify", pythonProxy);
  app.get("/alerts/pending", pythonProxy);
  app.post("/alerts/ack", pythonProxy);

  // Camera detector control (lists cameras, starts/stops the Python detector)
  app.get("/cameras", pythonProxy);
  app.post("/camera/start", pythonProxy);
  app.post("/camera/stop", pythonProxy);
  app.get("/camera/status", pythonProxy);

  return httpServer;
}
