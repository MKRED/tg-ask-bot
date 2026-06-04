export interface DanbooruApiPost {
  id: number;
  created_at: string;
  rating: string; // 'g' | 's' | 'q' | 'e'
  file_ext: string;
  file_size: number;
  md5: string | null;
  // Оригинал — может быть огромным (до 20MB+); используем large_file_url (sample, ~720px)
  file_url: string | null;
  large_file_url: string | null;
  preview_file_url: string | null;
  tag_string: string;
  tag_string_general: string;
  tag_string_character: string;
  tag_string_copyright: string;
  tag_string_artist: string;
  score: number;
  is_deleted: boolean;
  is_pending: boolean;
  is_banned: boolean;
}
