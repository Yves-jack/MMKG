import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const COURSE = encodeURIComponent("离散数学(图论+数理逻辑与集合论)").replace(/%2B/gi, "+");
const hub = "http://127.0.0.1:5173/c/" + COURSE;

const b = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox"],
});
const p = await b.newPage();
const cons = [];
p.on("console", (m) => {
  if (m.type() === "error") cons.push(m.text().slice(0, 120));
});

await p.goto(hub + "/apps/review/1", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
const fab = await p.$('button[title="图谱问答助手"]');
if (fab) await fab.click();
await new Promise((r) => setTimeout(r, 400));
const inpQa = await p.$('[role="dialog"] input');
if (inpQa) {
  await inpQa.click({ clickCount: 3 });
  await inpQa.type("集合");
  for (const x of await p.$$("button")) {
    const t = await p.evaluate((e) => e.textContent.trim(), x);
    if (t === "发送") {
      await x.click();
      break;
    }
  }
}
await new Promise((r) => setTimeout(r, 1200));
const qa = await p.evaluate(() => document.body.innerText);
console.log("QA_FAB", Boolean(fab));
console.log("QA_HAS_SET", qa.includes("集合"));

await p.goto(hub + "/apps/review/1", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
const reviewText = await p.evaluate(() => document.body.innerText);
console.log("REVIEW_OK", reviewText.includes("复习") || reviewText.length > 40);
console.log(
  "LATEX_NEST",
  cons.filter((c) => c.includes("cannot contain") || c.includes("descendant")).length
);
await b.close();
