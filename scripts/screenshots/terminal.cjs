const { chromium } = require('playwright');
const fs = require('fs');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Renders real output of the running demo agents (captured by run.sh) as terminal windows.
const dir = process.env.OUT ?? 'raw';
const shots = [
  ['56-terminal-pairing', '$ kubectl -n kubernanny logs deploy/kubernanny', fs.readFileSync(`${dir}/term-pairing.txt`, 'utf8'), 760],
  ['57-terminal-metrics', '$ curl -s kubernanny.kubernanny.svc:9100/metrics', fs.readFileSync(`${dir}/term-metrics.txt`, 'utf8'), 900],
  ['58-terminal-api', '$ GET /status   # one sealed call, exactly as the app makes it (Noise IK, device key)', fs.readFileSync(`${dir}/term-api.txt`, 'utf8'), 860],
];
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 980, height: 600 }, deviceScaleFactor: 2 });
  for (const [name, cmd, body, width] of shots) {
    await page.setViewportSize({ width, height: 600 });
    await page.setContent(`<body style="margin:0;background:#0b1020;padding:28px">
      <div style="border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);background:#101828">
        <div style="height:34px;background:#1b2438;display:flex;align-items:center;gap:8px;padding:0 14px">
          <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>
          <span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
          <span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
        </div>
        <pre style="margin:0;padding:18px 20px;color:#d7deee;font:13px/1.32 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all"><span style="color:#8ea2ff">${esc(cmd)}</span>\n${esc(body)}</pre>
      </div></body>`);
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width, height: h });
    await page.screenshot({ path: `${dir}/${name}.png` });
  }
  await b.close();
})();
