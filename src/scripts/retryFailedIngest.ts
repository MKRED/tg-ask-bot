import { eq } from "drizzle-orm";
import { HttpsProxyAgent } from "https-proxy-agent";
import { db } from "../db/index.js";
import { groupIngestImages } from "../db/schema.js";
import { analyzeImageOllama } from "../ai/ollama.js";
import { httpsPost } from "../utils/http.js";
import { config } from "../config.js";

async function getTelegramFileUrl(fileId: string): Promise<string> {
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
  const json = await httpsPost(
    `https://api.telegram.org/bot${config.botToken}/getFile`,
    { file_id: fileId },
    agent,
  ) as any;
  if (!json.ok) throw new Error(`getFile failed: ${JSON.stringify(json)}`);
  return `https://api.telegram.org/file/bot${config.botToken}/${json.result.file_path}`;
}

async function main() {
  const rows = await db.select().from(groupIngestImages).where(eq(groupIngestImages.analyzedBy, "failed"));
  console.log(`Failed rows: ${rows.length}`);

  for (const row of rows) {
    console.log(`\n--- id=${row.id} fileId=${row.fileId?.slice(0, 30)}...`);

    if (!row.fileId) {
      console.log("  No fileId, skipping");
      continue;
    }

    let fileUrl: string;
    try {
      fileUrl = await getTelegramFileUrl(row.fileId);
      console.log("  getFile: OK");
    } catch (err) {
      console.error("  getFile failed:", err);
      continue;
    }

    try {
      const result = await analyzeImageOllama(fileUrl);
      console.log("  Ollama: OK");
      console.log("  description:", result.description.slice(0, 80));
      console.log("  moodTags:", result.moodTags);
      console.log("  isNsfw:", result.isNsfw);

      await db.update(groupIngestImages).set({
        analyzedBy: "ollama",
        moodTags: result.moodTags,
        contentTags: result.contentTags,
        isNsfw: result.isNsfw,
      }).where(eq(groupIngestImages.id, row.id));
      console.log("  DB updated");
    } catch (err) {
      console.error("  Ollama failed:", err);
    }
  }

  console.log("\nDone");
  process.exit(0);
}

main().catch(console.error);
