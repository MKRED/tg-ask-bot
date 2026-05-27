import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config";
import logger from "./logger";

export class GeminiBlockedError extends Error {
  constructor(public readonly blockReason: string) {
    super(`Gemini blocked: ${blockReason}`);
    this.name = "GeminiBlockedError";
  }
}

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${config.geminiApiKey}`;

export interface ImageAnalysis {
  description: string;
  moodTags: string[];
  contentTags: string[];
}

const DESCRIPTION_PROMPT = `Проанализируй изображение:
- description: подробное описание на русском — объекты, люди, текст, цвета, атмосфера, стиль. Если мем — объясни суть и юмор.
- mood_tags: 5-10 тегов настроения/атмосферы на английском (funny, sad, cute, wholesome, cringe, dramatic, absurd, dark, cozy, romantic, epic...).
- content_tags: 8-15 тематических тегов на английском. Включай: имена персонажей если узнаёшь (astolfo, naruto...), серию/франшизу (fate, one_piece...), цвет волос (pink_hair...), одежду (armor, dress...), тип контента (meme, fan_art, photo, illustration...), архетип (femboy, girl, boy...), объекты и сеттинг.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    mood_tags: { type: "array", items: { type: "string" } },
    content_tags: { type: "array", items: { type: "string" } },
  },
  required: ["description", "mood_tags", "content_tags"],
};

function httpsPost(url: string, body: object, agent?: HttpsProxyAgent<string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
    https.get(url, { agent } as any, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export async function analyzeImage(fileUrl: string): Promise<ImageAnalysis> {
  const buffer = await downloadFile(fileUrl);
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;

  const body = {
    tools: [{ googleSearch: {} }],
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
    contents: [{
      parts: [
        { inline_data: { mime_type: "image/jpeg", data: buffer.toString("base64") } },
        { text: DESCRIPTION_PROMPT },
      ],
    }],
  };

  const t0 = Date.now();
  const data = await httpsPost(API_URL, body, agent);
  const durationMs = Date.now() - t0;

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new GeminiBlockedError(blockReason);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini error: ${JSON.stringify(data)}`);

  const usage = data?.usageMetadata;
  logger.info({ model: GEMINI_MODEL, durationMs, promptTokens: usage?.promptTokenCount, totalTokens: usage?.totalTokenCount }, "Gemini request completed");

  const parsed = JSON.parse(text);
  return {
    description: parsed.description,
    moodTags: parsed.mood_tags ?? [],
    contentTags: parsed.content_tags ?? [],
  };
}
