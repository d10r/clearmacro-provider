import http from "node:http";

/** @type {Record<string, { owners: string[] }>} */
const safes = {};

/** @type {Record<string, { safe: string; messageHash: string; message: unknown; preparedSignature: string }>} */
const messages = {};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/test/reset") {
    for (const key of Object.keys(safes)) delete safes[key];
    for (const key of Object.keys(messages)) delete messages[key];
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/test/configure-safe") {
    try {
      const body = await readJson(req);
      const safe = String(body.safe ?? "").toLowerCase();
      const owners = Array.isArray(body.owners)
        ? body.owners.map((owner) => String(owner).toLowerCase())
        : [];
      if (!/^0x[0-9a-f]{40}$/.test(safe) || owners.length === 0) {
        sendJson(res, 400, { error: "safe and owners required" });
        return;
      }
      safes[safe] = { owners };
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/test/configure-message") {
    try {
      const body = await readJson(req);
      const messageHash = String(body.messageHash ?? "").toLowerCase();
      const safe = String(body.safe ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(messageHash) || !/^0x[0-9a-f]{40}$/.test(safe)) {
        sendJson(res, 400, { error: "messageHash and safe required" });
        return;
      }
      messages[messageHash] = {
        safe,
        messageHash,
        message: body.message ?? {},
        preparedSignature: typeof body.preparedSignature === "string" ? body.preparedSignature : "",
      };
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  const safeMatch = url.pathname.match(/^\/api\/v1\/safes\/(0x[0-9a-fA-F]{40})\/$/);
  if (req.method === "GET" && safeMatch) {
    const safe = safeMatch[1].toLowerCase();
    const info = safes[safe];
    if (!info) {
      sendJson(res, 404, { detail: "Safe not found" });
      return;
    }
    sendJson(res, 200, {
      address: safe,
      nonce: 0,
      threshold: 1,
      owners: info.owners,
    });
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/v1\/messages\/(0x[0-9a-fA-F]{64})\/$/);
  if (req.method === "GET" && messageMatch) {
    const messageHash = messageMatch[1].toLowerCase();
    const record = messages[messageHash];
    if (!record) {
      sendJson(res, 404, { detail: "Message not found" });
      return;
    }
    sendJson(res, 200, record);
    return;
  }

  sendJson(res, 404, { detail: "not found" });
});

server.listen(8080, "0.0.0.0", () => {
  console.log("safe-tx-stub listening on :8080");
});
