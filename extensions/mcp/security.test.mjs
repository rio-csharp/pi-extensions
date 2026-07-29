import assert from "node:assert/strict";
import test from "node:test";
const {
  disambiguateToolName,
  isStrictLoopbackUrl,
  normalizedMcpToolName,
  parseSafeHttpUrl,
  sanitizeTerminalText,
} = await import("./.test-dist/index.js");

test("terminal sanitizer strips control, ANSI/OSC, bidi, and normalizes lines", () => {
  assert.equal(
    sanitizeTerminalText("ok\u001b[31m red\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\r\nnext\u202E"),
    "ok[31m red]8;;https://evillink]8;;\nnext",
  );
  assert.equal(sanitizeTerminalText("a\nb", { multiline: false }), "a b");
});

test("safe URL policy requires HTTPS except numeric loopback and rejects userinfo", () => {
  assert.equal(parseSafeHttpUrl("https://mcp.example.test/mcp").protocol, "https:");
  assert.equal(parseSafeHttpUrl("http://127.2.3.4:3000/mcp").protocol, "http:");
  assert.equal(parseSafeHttpUrl("http://[::1]:3000/mcp").protocol, "http:");
  assert.equal(isStrictLoopbackUrl(new URL("http://127.255.0.1")), true);
  assert.throws(() => parseSafeHttpUrl("http://localhost:3000/mcp"), /must use HTTPS/);
  assert.throws(() => parseSafeHttpUrl("http://192.168.1.10/mcp"), /must use HTTPS/);
  assert.throws(() => parseSafeHttpUrl("https://user@example.test/mcp"), /userinfo/);
  assert.throws(() => parseSafeHttpUrl("https://example.test/mcp#fragment"), /fragment/);
  assert.throws(() => parseSafeHttpUrl("javascript:alert(1)"), /must use HTTPS/);
});

test("normalized collisions, including synthetic read_resource, are deterministic", () => {
  const used = new Set();
  const firstBase = normalizedMcpToolName("server", "a-b");
  const secondBase = normalizedMcpToolName("server", "a_b");
  assert.equal(firstBase, secondBase);
  const first = disambiguateToolName(firstBase, "server\0tool\0a-b", used);
  used.add(first);
  const second = disambiguateToolName(secondBase, "server\0tool\0a_b", used);
  used.add(second);
  assert.notEqual(first, second);

  const remote = disambiguateToolName(normalizedMcpToolName("server", "read_resource"), "server\0tool\0read_resource", used);
  used.add(remote);
  const synthetic = disambiguateToolName(normalizedMcpToolName("server", "read_resource"), "server\0resource\0read_resource", used);
  assert.notEqual(remote, synthetic);
  assert.match(synthetic, /^mcp_server_read_resource_[a-f0-9]{10}$/);
});
