const PROJECT = /\b(?:P?\d{6,})(?:_D\d{3})?\b/i;
const REGION = /\bin\s+([\p{L}][\p{L}\s-]{1,40})\s*\??$/iu;

export function parseInventoryQuestion(input) {
  const text = String(input).trim();
  const project = text.match(PROJECT)?.[0];
  let region = text.match(REGION)?.[1]?.trim() ?? null;
  let term = text
    .replace(/^how\s+many\s+/i, "")
    .replace(/\s+left\??$/i, "")
    .replace(/^(?:stock|available)\s+/i, "")
    .replace(/\s+for\s+\b(?:P?\d{6,})(?:_D\d{3})?\b/i, "")
    .replace(REGION, "")
    .trim()
    .replace(/[?]+$/, "")
    .trim();
  if (!term || term.length > 100) return null;
  return { term, project_codes: project ? [project] : [], region };
}
