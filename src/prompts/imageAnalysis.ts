export const DESCRIPTION_PROMPT = `Проанализируй изображение:
- description: подробное описание на русском — объекты, люди, текст, цвета, атмосфера, стиль. Если мем — объясни суть и юмор.
- mood_tags: 5-10 тегов настроения/атмосферы на английском (funny, sad, cute, wholesome, cringe, dramatic, absurd, dark, cozy, romantic, epic...).
- content_tags: 8-15 тематических тегов на английском. Включай: имена персонажей если узнаёшь (astolfo, naruto...), серию/франшизу (fate, one_piece...), цвет волос (pink_hair...), одежду (armor, dress...), тип контента (meme, fan_art, photo, illustration...), архетип (femboy, girl, boy...), объекты и сеттинг.
- is_nsfw: true если изображение содержит откровенный сексуальный контент, обнажённость или 18+ материал, иначе false.`;

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    mood_tags: { type: "array", items: { type: "string" } },
    content_tags: { type: "array", items: { type: "string" } },
    is_nsfw: { type: "boolean" },
  },
  required: ["description", "mood_tags", "content_tags", "is_nsfw"],
};
