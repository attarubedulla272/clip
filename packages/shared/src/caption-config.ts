export const CAPTION_STYLE_CONFIG = {
  clean: {
    label: "Clean",
    fontSize: 68,
    bold: false,
    animation: "none"
  },
  karaoke: {
    label: "Karaoke",
    fontSize: 72,
    bold: true,
    animation: "karaoke"
  },
  "bold-pop": {
    label: "Bold pop",
    fontSize: 80,
    bold: true,
    animation: "emphasis"
  }
} as const;

export type CaptionStyle = keyof typeof CAPTION_STYLE_CONFIG;

export const CAPTION_CONFIG = {
  previewSeconds: 5,
  minimumWordDurationSeconds: 0.08,
  leadInSeconds: 0.08,
  chunkMinimumWords: 3,
  chunkMaximumWords: 6,
  lineMaximumWords: 3,
  pauseBreakSeconds: 0.45,
  emphasisMaximumFraction: 0.15,
  longPauseSeconds: 0.6,
  slowWordMedianMultiplier: 1.5,
  bottomSafeMarginPixels: 430,
  outlinePixels: 5,
  shadowPixels: 2,
  highlightColor: "&H0000D7FF",
  emphasisScalePercent: 118,
  emphasisPopMilliseconds: 120,
  fadeInMilliseconds: 70,
  strongVerbs: [
    "achieve", "build", "change", "create", "fail", "feel", "find", "grow", "heal",
    "improve", "learn", "lose", "make", "overcome", "remember", "transform", "win"
  ],
  strongNouns: [
    "brain", "change", "choice", "difference", "energy", "fear", "future", "gratitude",
    "health", "idea", "life", "mind", "problem", "result", "success", "truth"
  ],
  fillerWords: ["um", "uh"],
  duplicateComparisonMinimumLength: 1
} as const;

export const CAPTION_STYLES = Object.entries(CAPTION_STYLE_CONFIG).map(([id, style]) => ({
  id: id as CaptionStyle,
  label: style.label
}));
