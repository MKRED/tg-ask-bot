import { defineConfig } from "vitest/config";

// Тесты лежат рядом с кодом (*.test.ts) — со-локация, как и остальная фичевая структура.
// Из tsc-сборки (`yarn build`) они исключены через tsconfig "exclude", чтобы не попадать в dist/.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // forks-пул вместо threads: на Windows тред-пул вместе с холодным dep-оптимизатором Vite
    // иногда падает на первом запуске с «Cannot read properties of undefined (reading 'config')».
    // Отдельные процессы убирают эту гонку — прогон детерминирован даже на чистом кэше.
    pool: "forks",
  },
});
