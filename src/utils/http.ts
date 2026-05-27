import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";

export function httpsPost(url: string, body: object, agent?: HttpsProxyAgent<string>): Promise<any> {
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

export function downloadFile(url: string, agent?: HttpsProxyAgent<string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, { agent } as any, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}
