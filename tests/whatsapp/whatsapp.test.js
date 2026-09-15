import { describe, expect, test, vi } from "vitest";
import { authorize } from "../../apps/whatsapp-bot/src/authorization.js";
import { parseInventoryQuestion } from "../../apps/whatsapp-bot/src/parser.js";
import {
  createMessageHandler,
  handleUpsert,
} from "../../apps/whatsapp-bot/src/adapter.js";
import { formatInventoryReply } from "../../apps/whatsapp-bot/src/formatter.js";
import { createInventoryClient } from "../../apps/whatsapp-bot/src/inventory-client.js";
import { retryConnection } from "../../apps/whatsapp-bot/src/reconnect.js";

describe("WhatsApp boundary", () => {
  test.each([
    ["How many RRU left?", { term: "RRU", project_codes: [], region: null }],
    ["stock RRU", { term: "RRU", project_codes: [], region: null }],
    [
      "available RRU for P202202168750_D002",
      { term: "RRU", project_codes: ["P202202168750_D002"], region: null },
    ],
    ["RRU in Sabah", { term: "RRU", project_codes: [], region: "Sabah" }],
    [
      "How many RRU left in Sabah?",
      { term: "RRU", project_codes: [], region: "Sabah" },
    ],
    [
      "How many RRU left for P202202168750_D002?",
      {
        term: "RRU",
        project_codes: ["P202202168750_D002"],
        region: null,
      },
    ],
  ])("parses %s", (text, expected) =>
    expect(parseInventoryQuestion(text)).toEqual(expected),
  );

  test.each(["see you tomorrow", "let us meet later", "thanks", "ok"])(
    "ignores ordinary conversation %s",
    (text) => expect(parseInventoryQuestion(text)).toBeNull(),
  );

  test("group authorization requires both approved group and sender", () => {
    const rules = {
      senders: ["60111111111@s.whatsapp.net"],
      groups: ["123@g.us"],
    };
    expect(
      authorize(
        { chatId: "123@g.us", senderId: "60111111111@s.whatsapp.net" },
        rules,
      ),
    ).toBe(true);
    expect(
      authorize(
        { chatId: "123@g.us", senderId: "60999999999@s.whatsapp.net" },
        rules,
      ),
    ).toBe(false);
  });

  test("unauthorized and duplicate events never query", async () => {
    const query = vi.fn();
    const handler = createMessageHandler({
      rules: { senders: ["ok@s.whatsapp.net"], groups: [] },
      query,
    });
    expect(
      await handler({
        id: "1",
        chatId: "bad@s.whatsapp.net",
        senderId: "bad@s.whatsapp.net",
        text: "stock RRU",
      }),
    ).toBeNull();
    await handler({
      id: "2",
      chatId: "ok@s.whatsapp.net",
      senderId: "ok@s.whatsapp.net",
      text: "stock RRU",
    });
    await handler({
      id: "2",
      chatId: "ok@s.whatsapp.net",
      senderId: "ok@s.whatsapp.net",
      text: "stock RRU",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("formats totals and freshness without internals", () => {
    const text = formatInventoryReply({
      term: "RRU",
      available_now: "88",
      locked: "12",
      in_transfer: "18",
      snapshot_time: "2026-09-11T15:00:00+08:00",
      warnings: [],
      by_base_project: [{ base_project_code: "P1", available_now: "88" }],
    });
    expect(text).toContain("RRU available now: 88 units");
    expect(text).toContain("Data updated:");
    expect(text).not.toContain("stack");
  });

  test("preserves ambiguity candidates from API through the handler", async () => {
    const query = createInventoryClient({
      fetchImpl: async () => ({
        ok: false,
        json: async () => ({
          error: {
            code: "AMBIGUOUS_TERM",
            message: "ambiguous",
            candidates: ["Radio Cabinet", "Radio Remote Unit"],
          },
        }),
      }),
    });
    const handler = createMessageHandler({
      rules: { senders: ["ok@s.whatsapp.net"], groups: [] },
      query,
    });
    const reply = await handler({
      id: "ambiguous",
      chatId: "ok@s.whatsapp.net",
      senderId: "ok@s.whatsapp.net",
      text: "stock radio",
    });
    expect(reply).toContain("Radio Cabinet, Radio Remote Unit");
  });

  test("ignores history and append upserts after reconnect", async () => {
    const handler = vi.fn();
    const sendText = vi.fn();
    await handleUpsert(
      {
        type: "append",
        messages: [
          { key: { id: "old" }, message: { conversation: "stock RRU" } },
        ],
      },
      { handler, sendText },
    );
    expect(handler).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  test("continues an upsert after an individual send failure", async () => {
    const handler = vi.fn(async ({ id }) => `reply-${id}`);
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    await expect(
      handleUpsert(
        {
          type: "notify",
          messages: [
            {
              key: { id: "1", remoteJid: "a" },
              message: { conversation: "x" },
            },
            {
              key: { id: "2", remoteJid: "b" },
              message: { conversation: "y" },
            },
          ],
        },
        { handler, sendText, onError },
      ),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  test("retries rejected reconnect attempts with bounded backoff", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("auth read failed"))
      .mockRejectedValueOnce(new Error("socket failed"))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn(async () => {});
    const onError = vi.fn();
    await retryConnection(connect, {
      initialDelay: 1000,
      maxDelay: 2000,
      wait,
      onError,
    });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 2000]);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
