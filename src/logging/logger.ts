import pino from "pino";
import path from "node:path";
import fs from "node:fs";

let logger: pino.Logger | null = null;

export function getLogger(projectRoot?: string): pino.Logger {
  if (logger) return logger;

  const root = projectRoot ?? process.cwd();
  const logDir = path.join(root, ".burn", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, "burn.log");

  logger = pino(
    {
      level: process.env.BURN_LOG_LEVEL ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: pino.destination(logFile) },
      {
        stream: pino.destination(1), // stdout
        level: "info",
      },
    ])
  );

  return logger;
}

export function createSessionLogger(
  projectRoot: string,
  taskId: string,
  attemptNumber: number
): { logPath: string; write: (data: string) => void; close: () => void } {
  const logDir = path.join(projectRoot, ".burn", "logs", "sessions");
  fs.mkdirSync(logDir, { recursive: true });

  const logPath = path.join(logDir, `${taskId}_attempt${attemptNumber}.log`);
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  return {
    logPath,
    write: (data: string) => stream.write(data),
    close: () => stream.end(),
  };
}
