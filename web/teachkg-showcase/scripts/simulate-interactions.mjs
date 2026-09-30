/**
 * Full interaction pass: lecture switch, ask/miss, quiz loop, flash, timeline, switcher.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", ".sim");
fs.mkdirSync(outDir, { recursive: true });

const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://127.0.0.1:5173";
const COURSE = encodeURIComponent("离散数学(图论+数理逻辑与集合论)").replace(/%2B/gi, "+");
const hub = `${BASE}/c/${COURSE}`;

const findings = [];
const log = [];
function note(msg) {
  log.push(msg);
  console.log(msg);
}
function find(msg) {
  findings.push(msg);
  note(`FINDING ${msg}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  note(`SHOT ${name}`);
}

async function wait(ms = 700) {
  await new Promise((r) => setTimeout(r, ms));
}

async function clickText(page, text, exact = true) {
  const buttons = await page.$$("button, a");
  for (const b of buttons) {
    const t = (await page.evaluate((el) => el.textContent.trim().replace(/\s+/g, " "), b)) || "";
    if (exact ? t === text : t.includes(text)) {
      await b.click();
      return t;
    }
  }
  return null;
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.slice(0, 2500));
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
  page.on("pageerror", (e) => cons.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") cons.push(m.text());
  });

  // --- Review: load, switch lecture 2, collapse ---
  await page.goto(`${hub}/apps/review/1`, { waitUntil: "networkidle2", timeout: 30000 });
  await wait(900);
  const r1 = await bodyText(page);
  if (!r1.includes("第 1 讲") && !r1.includes("第1讲")) find("复习第1讲未显示讲次");
  const switched = await clickText(page, "第 2 讲", false);
  await wait(1000);
  await shot(page, "x-review-lec2");
  const r2 = await page.url();
  if (!r2.includes("/apps/review/2")) find(`复习切第2讲 URL 未变: ${r2}`);
  else note("OK review lecture 2");

  // --- Floating QA ---
  await page.goto(`${hub}/apps/review/1`, { waitUntil: "networkidle2" });
  await wait(800);
  const fab = await page.$('button[title="图谱问答助手"]');
  if (!fab) find("未找到悬浮问答按钮");
  else {
    await fab.click();
    note("OK qa fab open");
  }
  await wait(400);
  let input = await page.$('[role="dialog"] input');
  if (!input) input = await page.$("input");
  await input.click({ clickCount: 3 });
  await input.type("不存在的概念xyz");
  await clickText(page, "发送");
  await wait(1200);
  const miss = await bodyText(page);
  if (!miss.includes("未") && !miss.includes("命中") && !miss.includes("抱歉") && !miss.includes("没有")) {
    find("问答未命中没有提示");
  } else note("OK qa miss");
  await shot(page, "x-qa-def");
  // switch lecture in assistant select
  const sel = await page.$('[role="dialog"] select');
  if (sel) {
    await page.select('[role="dialog"] select', "2");
    await wait(900);
    await shot(page, "x-qa-lec2");
    note("OK qa lecture switch");
  }
  input = await page.$('[role="dialog"] input');
  if (!input) input = await page.$("input");
  await input.click({ clickCount: 3 });
  await input.type("图 和 顶点");
  await clickText(page, "发送");
  await wait(1200);
  await shot(page, "x-qa-compare-l2");
  note("OK qa compare send");

  // --- Practice: switch lecture, answer through to results ---
  await page.goto(`${hub}/apps/practice`, { waitUntil: "networkidle2" });
  await wait(900);
  await clickText(page, "第 1 讲");
  await wait(1200);
  await shot(page, "x-practice-lec1");
  let ptxt = await bodyText(page);
  if (ptxt.includes("0%")) find("练习第1讲仍显示 0%");
  if (ptxt.includes("暂无题目")) find("练习第1讲暂无题目");
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const t = await bodyText(page);
    if (t.includes("正确") && t.includes("%") && (t.includes("再练一组") || t.includes("带错题"))) {
      note(`OK practice finished after ${n} answers`);
      break;
    }
    const picked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const opt = btns.find((b) => /^[A-D]\. /.test(b.textContent.trim()));
      if (opt) {
        opt.click();
        return opt.textContent.trim();
      }
      return "";
    });
    if (!picked) {
      find(`练习第 ${i + 1} 步没有选项`);
      break;
    }
    n++;
    await wait(250);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const next = btns.find((b) => ["下一题", "查看结果", "完成"].includes(b.textContent.trim()));
      if (next) next.click();
    });
    await wait(250);
  }
  await shot(page, "x-practice-done");
  ptxt = await bodyText(page);
  if (!ptxt.includes("再练一组") && !ptxt.includes("带错题")) find("练习答完全部后没有结果页");
  if (ptxt.includes("带错题再练")) {
    await clickText(page, "带错题再练");
    await wait(500);
    await shot(page, "x-practice-wrongbook");
    const wb = await bodyText(page);
    if (!wb.includes("错题") && !wb.includes("第")) find("错题本没有题目");
    else note("OK wrongbook");
  }

  // --- Outline: lecture 2, click list item ---
  await page.goto(`${hub}/apps/outline`, { waitUntil: "networkidle2" });
  await wait(900);
  await clickText(page, "第 2 讲");
  await wait(1000);
  await shot(page, "x-outline-lec2");
  const o2 = await bodyText(page);
  if (o2.includes("点击导图节点") && !o2.match(/[一二三四五六七八九十\d]\. /)) {
    find("导图第2讲右侧仍是空提示且没有要点列表");
  } else note("OK outline lecture 2 has content");
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const item = btns.find((b) => /^\d+\./.test(b.textContent.trim()));
    if (item) item.click();
  });
  await wait(400);
  await shot(page, "x-outline-pick");

  // --- Resources: start ---
  await page.goto(`${hub}/apps/resources`, { waitUntil: "networkidle2" });
  await wait(800);
  const started = await clickText(page, "开始");
  await wait(1000);
  await shot(page, "x-resources-start");
  if (!page.url().includes("/apps/")) find(`推荐开始未跳转: ${page.url()}`);
  else note(`OK resources start -> ${page.url()}`);

  // animate / digest 入口已下线，旧路径应跳转到复习
  await page.goto(`${hub}/apps/animate`, { waitUntil: "networkidle2" });
  await wait(400);
  if (!page.url().includes("/apps/review")) find(`演化未重定向到复习: ${page.url()}`);
  else note("OK animate redirect");
  await page.goto(`${hub}/apps/digest`, { waitUntil: "networkidle2" });
  await wait(400);
  if (!page.url().includes("/apps/review")) find(`百科未重定向到复习: ${page.url()}`);
  else note("OK digest redirect");

  // --- AppSwitcher: 复习 -> 练习 ---
  await page.goto(`${hub}/apps/review/1`, { waitUntil: "networkidle2" });
  await wait(600);
  await clickText(page, "练习");
  await wait(800);
  if (!page.url().includes("/apps/practice")) find(`顶栏切练习失败: ${page.url()}`);
  else note("OK switcher review -> practice");

  fs.writeFileSync(
    path.join(outDir, "findings.txt"),
    ["FINDINGS", ...findings, "", "LOG", ...log, "", "CONSOLE", ...cons].join("\n"),
    "utf8"
  );
  note(`DONE findings=${findings.length} console=${cons.length}`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
