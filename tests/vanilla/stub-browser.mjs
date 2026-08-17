#!/usr/bin/env node
// Stands in for the system browser. open_url spawns `open` (macOS) or `xdg-open` (Linux) by
// name, so putting this on PATH under those names intercepts it without touching the channel.
//
// It does not just record the URL — it loads it in headless Chromium and waits for the page to
// pair, then writes the channel's own /health verdict to BROWSER_RESULT. That is what separates
// "the agent produced a plausible URL" from "the instructions actually work".
import { appendFileSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

// One line per invocation, not one file: an agent that opens two URLs must not have the second
// result silently replace the first, or the harness ends up validating one URL and pairing another.
const RESULT = process.env.BROWSER_RESULT;
const record = (o) => { if (RESULT) appendFileSync(RESULT, JSON.stringify(o) + "\n"); };

let target = process.argv[2];
if (!target) { record({ ok: false, why: "no url argument" }); process.exit(0); }

// macOS open_url does not pass the URL at all for file:// URLs with a hash — `open` strips
// fragments, so it writes a redirect shim and opens that bare path instead. The real URL has to
// be read back out of the shim, or this stub sees no cc= token and the agent, watching it fail,
// retries with an explicit browser path that no PATH shim can intercept.
if (!target.includes("://")) {
  try {
    const html = readFileSync(target, "utf8");
    const m = html.match(/location\.replace\(\s*("(?:[^"\\]|\\.)*")\s*\)/);
    if (m) target = JSON.parse(m[1]);
    else { record({ ok: false, why: `opened a local file that is not a redirect shim: ${target}` }); process.exit(0); }
  } catch (e) {
    record({ ok: false, why: `could not read ${target}: ${e.message}` });
    process.exit(0);
  }
}

const port = target.match(/cc=LOPE-(\d+)-/)?.[1];
if (!port) { record({ ok: false, why: "url carries no cc=LOPE-<port>- token", url: target }); process.exit(0); }

// Chrome 151 gates loopback WebSockets from an https origin behind Local Network Access, and
// headless denies the prompt outright rather than asking (see verify-https-pairing.mjs). A real
// user grants it; this stub cannot, so the gate is turned off. Consequence worth stating: this
// check attests that the instructions produce a URL that pairs, NOT that the LNA prompt works.
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-features=LocalNetworkAccessChecksWebSockets"],
});
try {
  const page = await browser.newPage();
  // "load", not "networkidle": the pairing WebSocket keeps the network busy indefinitely.
  await page.goto(target, { waitUntil: "load", timeout: 60000 });

  let health = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      health = await res.json();
      if (health.paired > 0) break;
    } catch { /* channel may still be binding */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  record({ ok: (health?.paired ?? 0) > 0, url: target, port: Number(port), health });
} catch (e) {
  record({ ok: false, why: `page load failed: ${e.message}`, url: target });
} finally {
  await browser.close();
}
