import net from "node:net";

export async function callMemstoreTool(socketPath, name, args = {}, timeoutMs = 2_000, { maxBytes } = {}) {
  const byteLimit = maxBytes === undefined ? Infinity : maxBytes;
  if (byteLimit !== Infinity && (!Number.isSafeInteger(byteLimit) || byteLimit < 1)) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let chunks = [];
    let received = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      chunks = [];
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`);
    });
    socket.on("data", (chunk) => {
      if (received + chunk.length > byteLimit) return finish(null);
      received += chunk.length;
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks, received);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      if (!line) return finish(null);
      try {
        const parsed = JSON.parse(line);
        finish(parsed.result?.structuredContent ?? parsed.result ?? null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
