export function formatInventoryReply(result) {
  if (result.error)
    return result.error.code === "AMBIGUOUS_TERM"
      ? `Please choose: ${(result.error.candidates ?? []).slice(0, 5).join(", ")}`
      : "Inventory data is temporarily unavailable. Please try again later.";
  const warning = result.warnings?.includes("STALE_SNAPSHOT")
    ? "⚠️ Warning: inventory data is stale.\n\n"
    : "";
  const projects =
    result.by_base_project
      ?.slice(0, 12)
      .map((p) => `• ${p.base_project_code}: ${p.available_now}`)
      .join("\n") || "• No matching stock";
  const updated = new Date(result.snapshot_time).toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${warning}${result.term} available now: ${result.available_now} units\n\nBy project:\n${projects}\n\nLocked: ${result.locked}\nIn transfer: ${result.in_transfer}\nData updated: ${updated}`.slice(
    0,
    3500,
  );
}
