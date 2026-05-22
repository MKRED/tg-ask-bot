import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config";

export class GeminiBlockedError extends Error {
  constructor(public readonly blockReason: string) {
    super(`Gemini blocked: ${blockReason}`);
    this.name = "GeminiBlockedError";
  }
}

const GEMINI_MODEL = "gemini-2.5-flash";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${config.geminiApiKey}`;

const SYSTEM_INSTRUCTION = `Format responses using ONLY these supported Telegram HTML tags:
- <b>bold</b> for important terms and headings
- <i>italic</i> for emphasis
- <code>code</code> for inline code
- <pre>code block</pre> for multi-line code

FORBIDDEN — never use: <h1>-<h6>, <ul>, <ol>, <li>, <hr>, <br>, <p>, <div>, <span>, or Markdown (**, __, \`, #, etc.).
Use plain newlines to separate sections. Use <b> instead of headings. Use "- " for lists instead of <ul><li>.`;

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

export async function analyzeImage(fileUrl: string, prompt: string): Promise<string> {
  const buffer = await downloadFile(fileUrl);
  const agent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
    contents: [{
      parts: [
        { inline_data: { mime_type: "image/jpeg", data: buffer.toString("base64") } },
        { text: prompt },
      ],
    }],
  };

  const data = await httpsPost(API_URL, body, agent);

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new GeminiBlockedError(blockReason);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini error: ${JSON.stringify(data)}`);
  return text;
}
