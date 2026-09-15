const PROJECT = /\b(?:P?\d{6,})(?:_D\d{3})?\b/i;
const REGION = /\bin\s+([\p{L}][\p{L}\s-]{1,40})\s*\??$/iu;
const INTENT = /^(?:how\s+many\b|stock\b|available\b)/i;
const QUANTITY = /\bleft\b/i;

export function parseInventoryQuestion(input) {
  const text = String(input).trim();
  const project = text.match(PROJECT)?.[0] ?? null;
  const region = text.match(REGION)?.[1]?.trim() ?? null;
  const looksLikeInventoryQuestion =
    INTENT.test(text) ||
    QUANTITY.test(text) ||
    Boolean(project) ||
    Boolean(region);
  if (!looksLikeInventoryQuestion) return null;
  const term = text
    .replace(/^how\s+many\s+/i, "")
    .replace(/^(?:stock|available)\s+/i, "")
    .replace(/\s+for\s+\b(?:P?\d{6,})(?:_D\d{3})?\b/i, "")
    .replace(REGION, "")
    .trim()
    .replace(/\s+left\??$/i, "")
    .trim()
    .replace(/[?]+$/, "")
    .trim();
  if (!term || term.length > 100) return null;
  return { term, project_codes: project ? [project] : [], region };
}
