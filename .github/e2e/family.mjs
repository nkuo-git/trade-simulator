// 在真的網站和真的 Firebase 上跑一次家長＋小孩的流程（會留下一個測試用家庭）
import { chromium } from 'playwright';
const U = 'https://nkuo-git.github.io/trade-simulator/';
const stamp = Date.now().toString(36);
const parentEmail = `e2e-parent-${stamp}@example.invalid`, kidEmail = `e2e-kid-${stamp}@example.invalid`;
const b = await chromium.launch();
const errs = [];
const mk = async (n) => { const c = await b.newContext(); const pg = await c.newPage(); pg.on('pageerror', (e) => errs.push(`${n}: ${e.message}`)); pg.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(`${n} ${m.type()}: ${m.text()}`); }); return pg; };
const P = await mk('parent'), K = await mk('kid'), K2 = await mk('kid2');
const dump = async () => {
  for (const [n, pg] of [['parent', P], ['kid', K]]) console.log(`--- ${n} 畫面 ---\n` + (await pg.evaluate(() => document.body.innerText)).slice(0, 1500));
  console.log('errors:', JSON.stringify(errs, null, 1));
  const key = kidEmail.replace(/\./g, ',');
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/trade-simulator-690ae/databases/(default)/documents/users/${encodeURIComponent(key)}?key=AIzaSyAqPQMRZfNkd0j7TuVLlrsirt14io-PXM8`);
  console.log('kid user doc:', r.status, (await r.text()).slice(0, 800));
};
process.on('uncaughtException', async (e) => { console.log('FAILED:', e.message); await dump(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.log('FAILED:', e.message); await dump(); process.exit(1); });
await P.goto(U); await P.fill('#login-email', parentEmail); await P.click('[data-act="login"]');
await P.click('[data-resolve="parent"]'); await P.fill('#pin', '9999'); await P.click('#pin-go');
await P.waitForSelector('.famcode.big b', { timeout: 20000 });
const code = await P.textContent('.famcode.big b'); console.log('family', code); await P.click('[data-resolve="ok"]');
await P.fill('#m-email', kidEmail); await P.click('[data-act="add-member"]'); await P.waitForTimeout(3000);
console.log('members shown:', await P.$$eval('.member', (els) => els.map((e) => e.innerText)));
await K.goto(U); await K.fill('#login-email', kidEmail); await K.click('[data-act="login"]');
await K.waitForSelector('#np-name', { timeout: 20000 }); await K.fill('#np-name', 'E2E'); await K.click('#np-go');
await K.click('[data-act="lesson"][data-id="1"]'); for (const i of [0, 1, 2]) await K.click(`.quiz[data-i="${i}"] .opt[data-j="1"]`); await K.click('#q-go');
await K.waitForTimeout(4000);
await P.waitForSelector('.card.kid', { timeout: 20000 }); console.log('parent sees kid: yes');
await K2.goto(U); await K2.fill('#login-email', kidEmail); await K2.click('[data-act="login"]'); await K2.waitForTimeout(5000);
const s = await K2.evaluate(() => JSON.parse(localStorage.getItem('kidtrader.v1')));
console.log('second phone restored:', s.profiles.length, s.profiles[0]?.name, JSON.stringify(s.profiles[0]?.lessons));
// 清掉測試玩家
await P.click('[data-act="p-delete"]'); await P.click('[data-resolve="y"]'); await P.waitForTimeout(2000);
console.log('errors:', JSON.stringify(errs));
await b.close();
if (s.profiles[0]?.name !== 'E2E' || !s.profiles[0]?.lessons.includes(1)) process.exit(1);
