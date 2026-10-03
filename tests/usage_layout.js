const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const executablePath = process.env.CHROME_PATH || (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 490, height: 420 } });
    const xhtml = fs.readFileSync('plugin_src/chrome/content/preferences.xhtml', 'utf8');
    const css = xhtml.match(/<html:style>([\s\S]*?)<\/html:style>/)[1];
    const js = fs.readFileSync('plugin_src/chrome/content/scripts/preferences.js', 'utf8');
    const positioning = js.slice(js.indexOf('    let positionedUsageYear = null;'), js.indexOf('    const renderUsage = () => {'));
    const cells = Array.from({ length: 371 }, (_, i) => `<button class="si-usage-day" data-today="${i === 267}"></button>`).join('');
    await page.setContent(`<style>${css}</style><div id="zotero-prefpane-mineru" style="display:none;width:440px"><div id="si-usage-scroll" class="si-usage-scroll"><div class="si-usage-calendar"><div id="si-usage-calendar" class="si-usage-grid">${cells}</div></div></div></div>`);
    await page.evaluate(source => {
      const doc = document;
      const usageYear = { value: '2026' };
      eval(source + '\nwindow.reposition = scheduleUsagePosition;');
      window.reposition();
    }, positioning);
    await page.waitForTimeout(80);
    await page.evaluate(() => { document.getElementById('zotero-prefpane-mineru').style.display = 'block'; });
    const centered = () => {
      const s = document.getElementById('si-usage-scroll');
      const r = s.getBoundingClientRect();
      const c = s.querySelector('[data-today="true"]').getBoundingClientRect();
      return s.scrollLeft > 0 && Math.abs(c.left + c.width / 2 - r.left - s.clientLeft - s.clientWidth / 2) < 1;
    };
    await page.waitForFunction(centered);
    await page.evaluate(() => { document.getElementById('si-usage-scroll').scrollLeft = 100; window.reposition(); });
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#si-usage-scroll').evaluate(el => el.scrollLeft), 100);
    await page.evaluate(() => { document.getElementById('zotero-prefpane-mineru').style.display = 'none'; });
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      const calendar = document.getElementById('si-usage-calendar');
      calendar.innerHTML = calendar.innerHTML;
      window.reposition();
      document.getElementById('zotero-prefpane-mineru').style.display = 'block';
    });
    await page.waitForFunction(centered);
    console.log('usage layout passed: delayed visibility, centering, manual scroll, reopen with replaced cells');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
