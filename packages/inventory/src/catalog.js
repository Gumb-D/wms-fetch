export const normalizeTerm = (value) =>
  String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function matchesTerm(
  record,
  term,
  aliases = { rru: ["rru", "radio remote unit", "remote radio unit"] },
) {
  const needle = normalizeTerm(term);
  const expansions = new Set([
    needle,
    ...(aliases[needle] ?? []).map(normalizeTerm),
  ]);
  const fields = [record.itemCode, record.product, record.alias]
    .filter(Boolean)
    .map(normalizeTerm);
  return [...expansions].some((candidate) =>
    fields.some((field) => field.includes(candidate)),
  );
}
