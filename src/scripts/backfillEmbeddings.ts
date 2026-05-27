import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { savedImages } from "../db/schema";
import { generateEmbedding } from "../ai/gemini";

async function main() {
  const rows = await db
    .select()
    .from(savedImages)
    .where(sql`embedding IS NULL`);

  console.log(`Found ${rows.length} images without embeddings`);

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    const text = `${row.description} ${[...row.moodTags, ...row.contentTags].join(" ")}`;
    try {
      const embedding = await generateEmbedding(text);
      await db
        .update(savedImages)
        .set({ embedding })
        .where(sql`id = ${row.id}`);
      ok++;
      console.log(`[${ok + failed}/${rows.length}] ✓ id=${row.id}`);
    } catch (err) {
      failed++;
      console.error(`[${ok + failed}/${rows.length}] ✗ id=${row.id}:`, err);
    }

    // небольшая пауза чтобы не упереться в rate limit
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nDone: ${ok} ok, ${failed} failed`);
}

main().catch(console.error);
