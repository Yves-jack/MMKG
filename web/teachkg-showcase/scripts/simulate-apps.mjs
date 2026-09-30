/**
 * Headless walkthrough of course hub + app pages.
 * Uses system Edge via puppeteer-core.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", ".sim");
fs.mkdirSync(outDir, { recursive: true });

const EDGE =
  process.env.EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.SIM_BASE || "http://127.0.0.1:5173";
const COURSE =
  process.env.SIM_COURSE ||
  encodeURIComponent("离散数学(图论+数理逻辑与集合论)").replace(/%2B/gi, "+");

const log = [];
function note(msg) {
  log.push(msg);
  console.log(msg);
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  note(`SHOT ${name}`);
  return file;
}

async function waitReady(page) {
  await page.waitForSelector("body", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 900));
}

async function consoleDump(page, label) {
  const errors = await page.evaluate(() => {
    return {
      title: document.title,
      h1: [...document.querySelectorAll("h1,h2")].slice(0, 8).map((n) => n.textContent.trim()),
      empty: [...document.querySelectorAll("[class*='empty']")].map((n) => n.textContent.trim()).slice(0, 6),
      buttons: [...document.querySelectorAll("button, a")].slice(0, 20).map((n) => n.textContent.trim()).filter(Boolean),
    };
  });
  note(`INFO ${label} ${JSON.stringify(errors)}`);
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  const cons = [];
  page.on("pageerror", (e) => cons.push(`pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") cons.push(`console.error ${m.text()}`);
  });

  const hub = `${BASE}/c/${COURSE}`;
  const routes = [
    ["00-home", `${BASE}/`],
    ["01-hub", hub],
    ["02-review", `${hub}/apps/review/1`],
    ["04-practice", `${hub}/apps/practice`],
    ["05-outline", `${hub}/apps/outline`],
    ["07-resources", `${hub}/apps/resources`],
  ];

  for (const [name, url] of routes) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await waitReady(page);
    await shot(page, name);
    await consoleDump(page, name);
  }

  // Floating QA: open assistant on review
  await page.goto(`${hub}/apps/review/1`, { waitUntil: "networkidle2" });
  await waitReady(page);
  const fab = await page.$('button[title="图谱问答助手"]');
  if (fab) {
    await fab.click();
    note("CLICK qa fab");
  }
  await new Promise((r) => setTimeout(r, 400));
  await shot(page, "03b-qa-open");
  const input = await page.$('[role="dialog"] input, .composer input');
  let asked = false;
  if (input) {
    await input.click({ clickCount: 3 });
    await input.type("集合");
    const sendBtns = await page.$$("button");
    for (const b of sendBtns) {
      const t = await page.evaluate((el) => el.textContent.trim(), b);
      if (t === "发送") {
        await b.click();
        asked = true;
        note("TYPE qa 集合");
        break;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  await shot(page, "03b-qa-asked");
  note(`QA asked=${asked}`);

  // Practice: pick first option
  await page.goto(`${hub}/apps/practice`, { waitUntil: "networkidle2" });
  await waitReady(page);
  const opts = await page.$$("button");
  for (const b of opts) {
    const t = await page.evaluate((el) => el.textContent.trim(), b);
    if (/^[A-D]\. /.test(t)) {
      await b.click();
      note(`CLICK practice option: ${t.slice(0, 40)}`);
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 600));
  await shot(page, "04b-practice-answered");

  // click 下一题 if present
  const nextBtns = await page.$$("button");
  for (const b of nextBtns) {
    const t = await page.evaluate((el) => el.textContent.trim(), b);
    if (t === "下一题" || t === "查看结果") {
      await b.click();
      note(`CLICK ${t}`);
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  await shot(page, "04c-practice-next");

  fs.writeFileSync(path.join(outDir, "log.txt"), [...log, "", "CONSOLE", ...cons].join("\n"), "utf8");
  await browser.close();
  note("DONE");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
