import pino from "pino";
import fs from "fs";
import { config } from "./config";

fs.mkdirSync("logs", { recursive: true });

const rollOptions = {
  target: "pino-roll",
  options: {
    file: "./logs/app.log",
    frequency: "daily",
    limit: { count: 7 },
    dateFormat: "yyyy-MM-dd",
  },
};

const logger = pino(
  process.stdout.isTTY
    ? {
        transport: {
          targets: [
            { target: "pino-pretty", options: { colorize: true }, level: config.logLevel },
            { ...rollOptions, level: config.logLevel },
          ],
        },
      }
    : {
        level: config.logLevel,
        transport: rollOptions,
      }
);

export default logger;
