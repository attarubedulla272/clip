export function transcriptScriptMismatch(whisperLanguage: string, transcript: string) {
  const detectedScript = whisperLanguage.startsWith("hi")
    ? /\p{Script=Devanagari}/gu
    : whisperLanguage.startsWith("te")
      ? /\p{Script=Telugu}/gu
      : undefined;
  if (!detectedScript) return false;
  const text = transcript.slice(0, 1000);
  const detectedCount = [...text.matchAll(detectedScript)].length;
  const latinCount = [...text.matchAll(/\p{Script=Latin}/gu)].length;
  return latinCount > 20 && latinCount > detectedCount * 2;
}
