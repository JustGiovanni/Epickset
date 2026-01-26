export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Attempt  extracting first JSON object block
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const slice = text.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error("Model did not return valid JSON.");
  }
}
