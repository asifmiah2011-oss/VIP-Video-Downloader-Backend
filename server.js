
const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const app = express();

const PORT = process.env.PORT || 3000;
const MAX_SIZE = 500 * 1024 * 1024;

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);

    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      p[0] >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();

    return (
      x === "::1" ||
      x === "::" ||
      x.startsWith("fc") ||
      x.startsWith("fd") ||
      x.startsWith("fe80:")
    );
  }

  return true;
}

async function validateURL(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }

  const addresses = await dns.lookup(url.hostname, {
    all: true
  });

  if (
    !addresses.length ||
    addresses.some(item => isPrivate(item.address))
  ) {
    throw new Error("Private addresses are blocked");
  }

  return url;
}

async function checkMedia(value) {
  const url = await validateURL(value);

  const response = await fetch(url, {
    method: "HEAD",
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error("Media server rejected the request");
  }

  const type = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  const size = Number(
    response.headers.get("content-length") || 0
  );

  const supported =
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/octet-stream";

  if (!supported) {
    throw new Error("This is not a supported media file");
  }

  if (size > MAX_SIZE) {
    throw new Error("Maximum file size is 500 MB");
  }

  return { url, type, size };
}

app.get("/", (req, res) => {
  res.send("VIP Video Downloader Backend is running.");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "VIP Video Downloader Backend"
  });
});

app.get("/api/check", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({
        ok: false,
        message: "URL is required"
      });
    }

    const media = await checkMedia(req.query.url);

    res.json({
      ok: true,
      contentType: media.type,
      size: media.size
    });

  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).send("URL is required");
    }

    const media = await checkMedia(req.query.url);

    // Revalidate before fetching the media.
    const url = await validateURL(media.url);

    const upstream = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(60000)
    });

    if (!upstream.ok || !upstream.body) {
      throw new Error("Unable to download media");
    }

    const size = Number(
      upstream.headers.get("content-length") || 0
    );

    if (size > MAX_SIZE) {
      throw new Error("File exceeds 500 MB");
    }

    const extension =
      media.type.includes("webm") ? "webm" :
      media.type.includes("quicktime") ? "mov" :
      media.type.includes("audio/") ? "audio" : "mp4";

    res.setHeader("Content-Type", media.type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="vip-video.${extension}"`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");

    const { Readable } = require("node:stream");

    Readable.fromWeb(upstream.body).pipe(res);

  } catch (error) {
    if (!res.headersSent) {
      res.status(400).send(error.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `VIP Backend running on port ${PORT}`
  );
});
