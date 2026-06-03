// Проверяет доступность Danbooru API напрямую и через прокси (если задан PROXY_URL).
// Запуск: yarn tsx src/scripts/checkDanbooruAccess.ts
import "dotenv/config";
import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";

const TEST_URL = "https://danbooru.donmai.us/posts.json?limit=1&tags=id:%3E0";
const TIMEOUT_MS = 10_000;

function testDirect(): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ ok: false, ms: Date.now() - t0, error: "timeout" }), TIMEOUT_MS);
    const url = new URL(TEST_URL);
    const req = https.get(
      { hostname: url.hostname, path: url.pathname + url.search, headers: { "User-Agent": "tg-ask-bot-check/1.0" } },
      (res) => {
        clearTimeout(timer);
        res.resume(); // сливаем тело
        resolve({ ok: res.statusCode! < 400, status: res.statusCode, ms: Date.now() - t0 });
      },
    );
    req.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, ms: Date.now() - t0, error: err.message }); });
  });
}

function testViaProxy(proxyUrl: string): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ ok: false, ms: Date.now() - t0, error: "timeout" }), TIMEOUT_MS);
    const agent = new HttpsProxyAgent(proxyUrl);
    const url = new URL(TEST_URL);
    const req = https.get(
      { hostname: url.hostname, path: url.pathname + url.search, headers: { "User-Agent": "tg-ask-bot-check/1.0" }, agent } as any,
      (res) => {
        clearTimeout(timer);
        res.resume();
        resolve({ ok: res.statusCode! < 400, status: res.statusCode, ms: Date.now() - t0 });
      },
    );
    req.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, ms: Date.now() - t0, error: err.message }); });
  });
}

const proxyUrl = process.env.PROXY_URL;

console.log("Checking Danbooru API access...\n");

const directResult = await testDirect();
console.log(`Direct:  ${directResult.ok ? "✅ OK" : "❌ FAIL"} — ${directResult.ms}ms${directResult.status ? ` (HTTP ${directResult.status})` : ""}${directResult.error ? ` — ${directResult.error}` : ""}`);

if (proxyUrl) {
  const proxyResult = await testViaProxy(proxyUrl);
  console.log(`Proxy:   ${proxyResult.ok ? "✅ OK" : "❌ FAIL"} — ${proxyResult.ms}ms${proxyResult.status ? ` (HTTP ${proxyResult.status})` : ""}${proxyResult.error ? ` — ${proxyResult.error}` : ""}`);
} else {
  console.log("Proxy:   ⚠️  PROXY_URL not set, skipped");
}

console.log("\nConclusion:");
if (directResult.ok) {
  console.log("→ Danbooru accessible directly. Proxy NOT needed.");
} else if (proxyUrl) {
  const proxyResult = await testViaProxy(proxyUrl);
  if (proxyResult.ok) {
    console.log("→ Direct failed, proxy works. Set requests to use PROXY_URL.");
  } else {
    console.log("→ Both direct and proxy failed. Check network or credentials.");
  }
} else {
  console.log("→ Direct failed and no PROXY_URL set. Try adding PROXY_URL to .env and re-run.");
}
