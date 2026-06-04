// Публичный API клиента Gemini. Импортёры используют этот barrel:
//   import { analyzeImage, generateTextEmbedding, GeminiBlockedError } from "../ai/gemini/index.js";
export { analyzeImage } from "./analyze.js";
export { generateTextEmbedding, generateImageEmbedding, generateImageEmbeddingFromBuffer } from "./embeddings.js";
export { GeminiBlockedError } from "./errors.js";
export type { ImageAnalysis } from "./types.js";
