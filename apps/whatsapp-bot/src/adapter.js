import { authorize } from "./authorization.js";
import { formatInventoryReply } from "./formatter.js";
import { parseInventoryQuestion } from "./parser.js";

export function createMessageHandler({ rules, query, maxRemembered = 2000 }) {
  const seen = new Set();
  return async (message) => {
    if (
      !message?.id ||
      !message.text ||
      message.fromMe ||
      message.chatId === "status@broadcast"
    )
      return null;
    if (!authorize(message, rules) || seen.has(message.id)) return null;
    seen.add(message.id);
    if (seen.size > maxRemembered) seen.delete(seen.values().next().value);
    const parsed = parseInventoryQuestion(message.text);
    if (!parsed) return null;
    try {
      return formatInventoryReply(await query(parsed));
    } catch (error) {
      return formatInventoryReply({
        error: {
          code: error.code ?? "API_UNAVAILABLE",
          candidates: error.candidates,
        },
      });
    }
  };
}
