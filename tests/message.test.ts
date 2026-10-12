import assert from "node:assert/strict";
import test from "node:test";
import { extractUnsubscribe, htmlToText, parseMessage } from "../src/message.js";

test("extracts only explicit unsubscribe headers without acting on links", () => {
  const source = Buffer.from(
    "From: news@example.com\r\n" +
    "List-Unsubscribe: <mailto:leave@example.com>,\r\n\t<https://example.com/u/123>, <http://insecure.example/u>\r\n" +
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n" +
    "Body with https://other.example/unsubscribe",
  );
  assert.deepEqual(extractUnsubscribe(source), {
    mailto: ["mailto:leave@example.com"],
    urls: ["https://example.com/u/123"],
    oneClick: true,
  });
});

test("parses unicode plain text and tolerates missing optional headers", async () => {
  const source = Buffer.from(
    "From: José <jose@example.com>\r\n" +
      "Subject: =?UTF-8?B?Q2Fmw6k=?=\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
      "Hello 🌵",
  );

  const result = await parseMessage(42, source, 500);

  assert.equal(result.uid, 42);
  assert.equal(result.senderAddress, "jose@example.com");
  assert.equal(result.subject, "Café");
  assert.equal(result.preview, "Hello 🌵");
  assert.equal(result.messageId, "");
});

test("sanitizes HTML and removes script and style content", () => {
  const result = htmlToText(
    '<style>.hidden{}</style><script>alert("x")</script><p>Hello&nbsp;<b>there</b></p><img src="https://tracker">',
  );

  assert.equal(result, "Hello there");
  assert.doesNotMatch(result, /tracker|alert|hidden/);
});

test("does not include attachment contents in the preview", async () => {
  const source = Buffer.from(
    [
      "From: sender@example.com",
      "Subject: Multipart",
      'Content-Type: multipart/mixed; boundary="x"',
      "",
      "--x",
      "Content-Type: text/plain",
      "",
      "Visible body",
      "--x",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="secret.txt"',
      "",
      "ATTACHMENT SECRET",
      "--x--",
      "",
    ].join("\r\n"),
  );

  const result = await parseMessage(7, source, 500);

  assert.equal(result.preview, "Visible body");
  assert.doesNotMatch(result.preview, /ATTACHMENT SECRET/);
});

test("limits text from a truncated message source", async () => {
  const source = Buffer.from(
    `From: sender@example.com\r\nContent-Type: text/plain\r\n\r\n${"a".repeat(100)}`,
  );

  const result = await parseMessage(8, source.subarray(0, source.length - 20), 25);

  assert.equal(result.preview.length, 25);
});
