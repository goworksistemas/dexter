import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import { endSSE, initSSE, writeSSE, writeSSEHeartbeat } from "./sse.js";

function fakeReply() {
  const chunks: string[] = [];
  let ended = false;
  let head: { status: number; headers: Record<string, string> } | null = null;
  const reply = {
    raw: {
      writeHead(status: number, headers: Record<string, string>) {
        head = { status, headers };
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {
        ended = true;
      },
    },
  } as unknown as FastifyReply;
  return {
    reply,
    chunks,
    get text() {
      return chunks.join("");
    },
    get head() {
      return head;
    },
    get ended() {
      return ended;
    },
  };
}

describe("initSSE", () => {
  it("abre stream com headers text/event-stream", () => {
    const f = fakeReply();
    initSSE(f.reply);
    expect(f.head?.status).toBe(200);
    expect(f.head?.headers["Content-Type"]).toBe("text/event-stream");
    expect(f.head?.headers["Cache-Control"]).toContain("no-cache");
    expect(f.head?.headers["X-Accel-Buffering"]).toBe("no");
  });
});

describe("writeSSE", () => {
  it("escreve event + data JSON + linha em branco", () => {
    const f = fakeReply();
    writeSSE(f.reply, {
      event: "text-delta",
      data: { textDelta: "olá" },
    });
    expect(f.text).toBe(
      'event: text-delta\ndata: {"textDelta":"olá"}\n\n',
    );
  });

  it("serializa done com objeto vazio", () => {
    const f = fakeReply();
    writeSSE(f.reply, { event: "done", data: {} });
    expect(f.text).toBe("event: done\ndata: {}\n\n");
  });

  it("serializa progress e error no mesmo contrato", () => {
    const f = fakeReply();
    writeSSE(f.reply, {
      event: "progress",
      data: { type: "status", text: "Pensando" },
    });
    writeSSE(f.reply, {
      event: "error",
      data: { message: "falhou" },
    });
    expect(f.text).toContain("event: progress\n");
    expect(f.text).toContain('"type":"status"');
    expect(f.text).toContain("event: error\n");
    expect(f.text).toContain('"message":"falhou"');
    expect(f.text.endsWith("\n\n")).toBe(true);
  });
});

describe("writeSSEHeartbeat / endSSE", () => {
  it("heartbeat é comentário SSE com keepalive", () => {
    const f = fakeReply();
    const before = Date.now();
    writeSSEHeartbeat(f.reply);
    const after = Date.now();
    expect(f.text.startsWith(": keepalive ")).toBe(true);
    expect(f.text.endsWith("\n\n")).toBe(true);
    const ts = Number(f.text.slice(": keepalive ".length, -2));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("endSSE fecha o stream", () => {
    const f = fakeReply();
    endSSE(f.reply);
    expect(f.ended).toBe(true);
  });
});
