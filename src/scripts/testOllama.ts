import { config } from "../config.js";
import { analyzeImageOllama } from "../ai/ollama.js";

// Тестовая картинка по умолчанию — небольшое публичное изображение.
// Можно переопределить через аргумент: yarn tsx src/scripts/testOllama.ts <url>
const TEST_IMAGE_URL = process.argv[2] ?? "https://www.gstatic.com/webp/gallery/1.jpg";

async function main() {
  console.log("=== Проверка Ollama ===");
  console.log(`OLLAMA_URL          : ${config.ollamaUrl}`);
  console.log(`OLLAMA_VISION_MODEL : ${config.ollamaVisionModel}`);
  console.log("");

  // 1. Доступна ли вообще Ollama и какие модели установлены
  console.log("1) Проверяю доступность Ollama (/api/tags)...");
  let models: string[] = [];
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`);
    if (!res.ok) {
      console.error(`   ✗ Ollama ответила HTTP ${res.status}`);
      process.exit(1);
    }
    const data: any = await res.json();
    models = (data?.models ?? []).map((m: any) => m.name);
    console.log(`   ✓ Ollama доступна. Установленные модели: ${models.join(", ") || "(нет)"}`);
  } catch (err) {
    console.error("   ✗ Не удалось подключиться к Ollama:", err);
    console.error("   Убедись, что Ollama запущена (ollama serve) и OLLAMA_URL верный.");
    process.exit(1);
  }

  // 2. Есть ли нужная vision-модель (имя в /api/tags обычно с тегом, напр. "gemma4-vision:latest")
  const hasModel = models.some(
    (m) => m === config.ollamaVisionModel || m.startsWith(`${config.ollamaVisionModel}:`)
  );
  if (!hasModel) {
    console.warn(
      `\n   ⚠ Модель "${config.ollamaVisionModel}" не найдена среди установленных.\n` +
        `   Скачай её: ollama pull ${config.ollamaVisionModel}`
    );
  } else {
    console.log(`   ✓ Модель "${config.ollamaVisionModel}" установлена.`);
  }

  // 3. Реальный прогон фоллбэка на тестовой картинке
  console.log(`\n2) Прогоняю analyzeImageOllama на картинке:\n   ${TEST_IMAGE_URL}`);
  const t0 = Date.now();
  try {
    const result = await analyzeImageOllama(TEST_IMAGE_URL);
    console.log(`\n   ✓ Ответ получен за ${Date.now() - t0} мс:`);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`\n   ✗ analyzeImageOllama упал за ${Date.now() - t0} мс:`, err);
    process.exit(1);
  }

  console.log("\n=== Готово ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
