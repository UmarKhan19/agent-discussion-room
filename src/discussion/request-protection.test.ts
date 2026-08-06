import { describe, expect, it } from "vitest";
import {
  clientNetworkKey,
  hasJsonContentType,
  readBoundedBody,
} from "./request-protection";

function jsonRequest(body: string): Request {
  return new Request("http://localhost/api/discussions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("request transport guards", () => {
  describe("hasJsonContentType", () => {
    it.each([
      ["application/json", true],
      ["application/json; charset=utf-8", true],
      ["application/vnd.discussion+json", true],
      ["APPLICATION/JSON", true],
      ["text/plain", false],
      ["application/x-www-form-urlencoded", false],
      ["multipart/form-data", false],
    ])("classifies %s", (header, expected) => {
      expect(
        hasJsonContentType(
          new Request("http://localhost/", {
            method: "POST",
            headers: { "Content-Type": header },
            body: "{}",
          }),
        ),
      ).toBe(expected);
    });

    it("rejects a missing content type", () => {
      expect(
        hasJsonContentType(
          new Request("http://localhost/", { method: "POST", body: "{}" }),
        ),
      ).toBe(false);
    });
  });

  describe("readBoundedBody", () => {
    it("returns the body text within the limit", async () => {
      const body = JSON.stringify({ topic: "A permitted Topic" });
      const result = await readBoundedBody(jsonRequest(body), 4096);

      expect(result).toEqual({ ok: true, text: body });
    });

    it("rejects a declared Content-Length above the limit without reading", async () => {
      const request = new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "5000",
        },
        body: "x".repeat(5000),
      });

      expect(await readBoundedBody(request, 4096)).toEqual({ ok: false });
    });

    it("accepts a body exactly at the byte limit", async () => {
      const body = "x".repeat(100);
      expect(await readBoundedBody(jsonRequest(body), 100)).toEqual({
        ok: true,
        text: body,
      });
    });

    it("abandons a chunked body that exceeds the limit mid-stream", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("x".repeat(80)));
          controller.enqueue(encoder.encode("y".repeat(80)));
          controller.close();
        },
      });
      const request = new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit);

      expect(await readBoundedBody(request, 100)).toEqual({ ok: false });
    });

    it("returns an empty body for a request without a stream", async () => {
      const request = new Request("http://localhost/api/discussions", {
        method: "POST",
      });
      expect(await readBoundedBody(request, 4096)).toEqual({
        ok: true,
        text: "",
      });
    });
  });

  describe("clientNetworkKey", () => {
    it("uses the first X-Forwarded-For address", () => {
      const request = new Request("http://localhost/", {
        headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
      });
      expect(clientNetworkKey(request)).toBe("203.0.113.7");
    });

    it("falls back to X-Real-IP", () => {
      const request = new Request("http://localhost/", {
        headers: { "X-Real-IP": "198.51.100.4" },
      });
      expect(clientNetworkKey(request)).toBe("198.51.100.4");
    });

    it("falls back to a shared key when no address header exists", () => {
      expect(clientNetworkKey(new Request("http://localhost/"))).toBe(
        "unknown",
      );
    });

    it("ignores an empty X-Forwarded-For entry", () => {
      const request = new Request("http://localhost/", {
        headers: { "X-Forwarded-For": " , " },
      });
      expect(clientNetworkKey(request)).toBe("unknown");
    });
  });
});
