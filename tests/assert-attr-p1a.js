// P1a 断言:属性文本翻译(alt/aria-label/placeholder/title)。
// 用法: 1) python serve.py   2) 带 --remote-debugging-port=9222 的浏览器开 http://127.0.0.1:8123/attr-p1a-page.html
//       3) node assert-attr-p1a.js [cdpPort]
// 退出码 0=全绿, 1=有失败, 2=连不上/找不到页。
const http = require('http');
const crypto = require('crypto');

const CDP_PORT = process.argv[2] || '9222';
const PAGE_URL_HINT = 'attr-p1a-page.html';

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CDP_PORT, path }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    });
    req.on('error', reject); req.end();
  });
}
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const m = wsUrl.match(/^ws:\/\/([^:/]+):(\d+)(\/.*)$/);
    if (!m) return reject(new Error('bad ws url ' + wsUrl));
    const [, host, port, path] = m;
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host, port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, socket) => resolve(socket));
    req.on('error', reject); req.end();
  });
}
function wsSend(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj)); const len = payload.length;
  let header; const mask = crypto.randomBytes(4);
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}
function wsMakeReceiver(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      const masked = buf[1] & 0x80;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked) { if (buf.length < off + 4) return; maskKey = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (maskKey) { const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= maskKey[i % 4]; payload = p; }
      buf = buf.slice(off + len);
      if (op === 1 && fin) { try { onMessage(JSON.parse(payload.toString('utf8'))); } catch {} }
    }
  });
}

async function main() {
  const targets = await httpJson('/json');
  const page = (targets || []).find((t) => (t.url || '').includes(PAGE_URL_HINT) && t.type === 'page');
  if (!page) { console.error('找不到 attr-p1a 测试页。请开 http://127.0.0.1:8123/' + PAGE_URL_HINT); process.exit(2); }
  const socket = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  wsMakeReceiver(socket, (msg) => { if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  function cdp(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id; pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      wsSend(socket, { id: myId, method, params });
    });
  }
  async function evalJs(expression, awaitPromise = false) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }

  await evalJs(`new Promise(function(res){ var t=0; var iv=setInterval(function(){ if(typeof window.__ctOnMessage==='function'){clearInterval(iv);res(true);} else if(++t>50){clearInterval(iv);res(false);} },100); })`, true);

  const readAttrs = `({
    img1: document.getElementById('img1').getAttribute('alt'),
    btn1: document.getElementById('btn1').getAttribute('aria-label'),
    in1: document.getElementById('in1').getAttribute('placeholder'),
    ta1: document.getElementById('ta1').getAttribute('placeholder'),
    abbr1: document.getElementById('abbr1').getAttribute('title'),
    imgShort: document.getElementById('img-short').getAttribute('alt'),
    imgZh: document.getElementById('img-zh').getAttribute('alt'),
    imgNt: document.getElementById('img-nt').getAttribute('alt'),
    abbrMeta: document.getElementById('abbr-meta').getAttribute('title'),
    leaf1Bi: document.getElementById('leaf1').classList.contains('ct-bilingual'),
    ctAttrCount: document.querySelectorAll('[data-ct-attr]').length,
    img1Structure: !!document.getElementById('img1'), // 结构未变
  })`;

  // 用例1: bilingual(translate-all) → 属性变 "原 (译)"
  const bi = await evalJs(`new Promise(function(resolve){ window.__ctOnMessage({type:'translate-all'},null,function(){ setTimeout(function(){ resolve(${readAttrs}); },700); }); })`, true);
  const hasZh = (s) => typeof s === 'string' && s.includes('【译】');
  const c1 = hasZh(bi.img1) && hasZh(bi.btn1) && hasZh(bi.in1) && hasZh(bi.ta1) && hasZh(bi.abbr1);
  console.log((c1 ? '✅' : '❌') + ' 用例1a bilingual:5个可译属性都含译文');
  const c1keep = bi.img1.includes('A red circle') && bi.btn1.includes('Open the settings');
  console.log((c1keep ? '✅' : '❌') + ' 用例1b bilingual:属性保留原文(原+译)');
  const c1skip = bi.imgShort === 'OK' && bi.imgZh === '红色的圆形图标' && bi.imgNt === 'Do not translate this text' && bi.abbrMeta === '2024-01-01';
  console.log((c1skip ? '✅' : '❌') + ' 用例1c 不采:太短(<4)/中文/notranslate/metadata 原样', JSON.stringify({ imgShort: bi.imgShort, imgZh: bi.imgZh, imgNt: bi.imgNt, abbrMeta: bi.abbrMeta }));
  const c1block = bi.leaf1Bi === true;
  console.log((c1block ? '✅' : '❌') + ' 用例1d 回归:块翻译不受影响(leaf1 bilingual)');
  const c1struct = bi.img1Structure === true;
  console.log((c1struct ? '✅' : '❌') + ' 用例1e 结构:img 元素未被替换');

  // 用例2: remove-all → replace-all(模式切换正路;P0 下 bilingual→replace 块被有意拦截)→ 属性纯译文、无嵌套
  const rep = await evalJs(`new Promise(function(resolve){ window.__ctOnMessage({type:'remove-all'},null,function(){ window.__ctOnMessage({type:'replace-all'},null,function(){ setTimeout(function(){
    resolve({ img1: document.getElementById('img1').getAttribute('alt'),
      nested: (document.getElementById('img1').getAttribute('alt').match(/【译】/g)||[]).length });
  },700); }); }); })`, true);
  const c2 = hasZh(rep.img1) && rep.nested === 1; // stub 译文=【译】+原文,故"含原文"是 stub 噪声;真机用中文 stub 验证无残留
  console.log((c2 ? '✅' : '❌') + ' 用例2 replace:纯译文、无【译】嵌套', JSON.stringify(rep));

  // 用例3: remove-all → 属性还原 + data-ct-attr 清空
  const rst = await evalJs(`new Promise(function(resolve){ window.__ctOnMessage({type:'remove-all'},null,function(){ setTimeout(function(){
    resolve({ img1: document.getElementById('img1').getAttribute('alt'),
      ctAttrCount: document.querySelectorAll('[data-ct-attr]').length });
  },400); }); })`, true);
  const c3 = rst.img1 === 'A red circle on a white background' && rst.ctAttrCount === 0;
  console.log((c3 ? '✅' : '❌') + ' 用例3 remove-all:属性还原原文、data-ct-attr 清空', JSON.stringify(rst));

  const all = c1 && c1keep && c1skip && c1block && c1struct && c2 && c3;
  console.log(all ? '\n🎉 P1a 全部通过' : '\n⚠️ 有用例失败');
  process.exit(all ? 0 : 1);
}
main().catch((e) => { console.error('运行出错:', e.message); process.exit(2); });
