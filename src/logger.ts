import pino from "pino";
import fs from "fs";

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
            { target: "pino-pretty", options: { colorize: true }, level: "debug" },
            { ...rollOptions, level: "debug" },
          ],
        },
      }
    : {
        level: "debug",
        transport: rollOptions,
      }
);

export default logger;
