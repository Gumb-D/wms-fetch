export function authorize(message, rules) {
  const senderAllowed = rules.senders.includes(message.senderId);
  if (message.chatId.endsWith("@g.us"))
    return senderAllowed && rules.groups.includes(message.chatId);
  return senderAllowed && message.chatId === message.senderId;
}
