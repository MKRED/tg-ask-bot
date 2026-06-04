import { describe, it, expect } from "vitest";
import {
  danbooruPostUrl,
  extToMimeType,
  isNsfwRating,
  splitTags,
  buildDescriptionAndTags,
} from "./transform.js";
import type { DanbooruApiPost } from "./types.js";

// Фабрика минимального поста — заполняем только поля, которые читает transform.
// Остальное помечаем как DanbooruApiPost через as, чтобы не тащить нерелевантные поля в каждый тест.
function makePost(overrides: Partial<DanbooruApiPost>): DanbooruApiPost {
  return {
    id: 1,
    tag_string_general: "",
    tag_string_character: "",
    tag_string_copyright: "",
    tag_string_artist: "",
    ...overrides,
  } as DanbooruApiPost;
}

describe("danbooruPostUrl", () => {
  it("строит ссылку на пост из id", () => {
    expect(danbooruPostUrl(12345)).toBe("https://danbooru.donmai.us/posts/12345");
  });
});

describe("extToMimeType", () => {
  it("маппит известные расширения", () => {
    expect(extToMimeType("jpg")).toBe("image/jpeg");
    expect(extToMimeType("jpeg")).toBe("image/jpeg");
    expect(extToMimeType("png")).toBe("image/png");
    expect(extToMimeType("webp")).toBe("image/webp");
  });

  it("регистронезависим", () => {
    expect(extToMimeType("PNG")).toBe("image/png");
    expect(extToMimeType("JPG")).toBe("image/jpeg");
  });

  it("неизвестное расширение → image/jpeg по умолчанию", () => {
    expect(extToMimeType("gif")).toBe("image/jpeg");
    expect(extToMimeType("")).toBe("image/jpeg");
  });
});

describe("isNsfwRating", () => {
  it("q и e — NSFW", () => {
    expect(isNsfwRating("q")).toBe(true);
    expect(isNsfwRating("e")).toBe(true);
  });

  it("g и s — SFW", () => {
    expect(isNsfwRating("g")).toBe(false);
    expect(isNsfwRating("s")).toBe(false);
  });

  it("неизвестный рейтинг трактуется как SFW", () => {
    expect(isNsfwRating("")).toBe(false);
    expect(isNsfwRating("x")).toBe(false);
  });
});

describe("splitTags", () => {
  it("разбивает пробел-разделённую строку", () => {
    expect(splitTags("tag1 tag2 tag3")).toEqual(["tag1", "tag2", "tag3"]);
  });

  it("отбрасывает пустые токены от лишних пробелов", () => {
    expect(splitTags("  tag1   tag2  ")).toEqual(["tag1", "tag2"]);
  });

  it("пустая строка → пустой массив", () => {
    expect(splitTags("")).toEqual([]);
  });
});

describe("buildDescriptionAndTags", () => {
  it("строит описание с метками и сырые теги по категориям", () => {
    const post = makePost({
      tag_string_general: "long_hair smile",
      tag_string_character: "hatsune_miku",
      tag_string_copyright: "vocaloid",
      tag_string_artist: "some_artist",
    });
    const r = buildDescriptionAndTags(post);

    // description нормализован (underscore → пробел) и снабжён метками
    expect(r.description).toBe(
      "Characters: hatsune miku. From: vocaloid. Art by: some artist. long hair smile",
    );

    // сырые *Tags сохраняют underscore-форму для аудита
    expect(r.characterTags).toEqual(["hatsune_miku"]);
    expect(r.copyrightTags).toEqual(["vocaloid"]);
    expect(r.artistTags).toEqual(["some_artist"]);
    expect(r.generalTags).toEqual(["long_hair", "smile"]);
  });

  it("contentTags нормализованы и упорядочены: сущности впереди general", () => {
    const post = makePost({
      tag_string_general: "long_hair smile",
      tag_string_character: "hatsune_miku",
      tag_string_copyright: "vocaloid",
      tag_string_artist: "some_artist",
    });
    const r = buildDescriptionAndTags(post);

    expect(r.contentTags).toEqual([
      "hatsune miku",
      "vocaloid",
      "some artist",
      "long hair",
      "smile",
    ]);
  });

  it("дедуплицирует пересекающиеся теги в contentTags", () => {
    // тег встречается и в character, и в general — в contentTags должен остаться один раз
    const post = makePost({
      tag_string_general: "solo hatsune_miku",
      tag_string_character: "hatsune_miku",
    });
    const r = buildDescriptionAndTags(post);

    expect(r.contentTags).toEqual(["hatsune miku", "solo"]);
  });

  it("без тегов вообще → fallback-описание с id и пустые массивы", () => {
    const post = makePost({ id: 999 });
    const r = buildDescriptionAndTags(post);

    expect(r.description).toBe("Danbooru post 999");
    expect(r.contentTags).toEqual([]);
    expect(r.characterTags).toEqual([]);
  });

  it("обрезает general-теги в описании по лимиту 30", () => {
    const general = Array.from({ length: 40 }, (_, i) => `tag${i}`).join(" ");
    const post = makePost({ tag_string_general: general });
    const r = buildDescriptionAndTags(post);

    // в описании только первые 30 general-тегов
    const wordsInDescription = r.description.split(" ").length;
    expect(wordsInDescription).toBe(30);
    // но сырой generalTags хранит все 40
    expect(r.generalTags).toHaveLength(40);
  });

  it("обрезает contentTags по лимиту 60", () => {
    const general = Array.from({ length: 80 }, (_, i) => `tag${i}`).join(" ");
    const post = makePost({ tag_string_general: general });
    const r = buildDescriptionAndTags(post);

    expect(r.contentTags).toHaveLength(60);
  });
});
