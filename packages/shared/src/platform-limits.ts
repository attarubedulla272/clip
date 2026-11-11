export const PLATFORM_LIMITS = {
  youtubeShorts: {
    titleCharacters: 70,
    descriptionCharacters: 5_000,
    tagCount: { min: 10, max: 15 },
    tagCharacters: 500,
    totalTagCharacters: 500,
    hashtagCount: { min: 3, max: 5 },
    hashtagCharacters: 100
  },
  instagramReels: {
    captionCharacters: 2_200,
    hashtagCount: { min: 3, max: 5 },
    hashtagCharacters: 100
  },
  tiktok: {
    captionCharacters: 2_200,
    hashtagCount: { min: 3, max: 5 },
    hashtagCharacters: 100
  }
} as const;
