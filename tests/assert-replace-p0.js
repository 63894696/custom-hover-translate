// 自动化断言 replace-p0:连 CDP(默认 9222)找到测试页,跑三个用例。
// 用法: 1) python serve.py   2) 浏览器(带 --remote-debugging-port=9222)开 http://127.0.0.1:8123/
//       3) node assert-replace-p0.js [cdpPort]
// 退出码 0=全绿, 1=有用例失败, 2=连不上/找不到页。
const http = require('http');

const CDP_PORT = process.argv[2] || '9222';
const PAGE_URL_HINT = '127.0.0.1:8123';

function httpJson(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CDP_PORT, path, method }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// 最小 WebSocket 客户端(仅发文本帧、收文本帧),够 CDP 用
const crypto = require('crypto');
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const m = wsUrl.match(/^ws:\/\/([^:/]+):(\d+)(\/.*)$/);
    if (!m) return reject(new Error('bad ws url ' + wsUrl));
    const [, host, port, path] = m;
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host, port, path,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });
}
function wsSend(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  const mask = crypto.randomBytes(4);
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
      // (不处理分片/ping——CDP 消息一般单帧文本)
    }
  });
}

async function main() {
  const targets = await httpJson('/json');
  const page = (targets || []).find((t) => (t.url || '').includes(PAGE_URL_HINT) && t.type === 'page');
  if (!page) { console.error('找不到测试页 target。请确认浏览器(带 CDP)已开 http://' + PAGE_URL_HINT + '/'); process.exit(2); }
  const socket = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  wsMakeReceiver(socket, (msg) => {
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function cdp(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      wsSend(socket, { id: myId, method, params });
    });
  }
  async function evalJs(expression, awaitPromise = false) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }

  // 等 content.js 注入完成
  await evalJs(`new Promise(function(res){ var t=0; var iv=setInterval(function(){ if(typeof window.__ctOnMessage==='function'){clearInterval(iv);res(true);} else if(++t>50){clearInterval(iv);res(false);} },100); })`, true);

  // 用例1: replace-all
  const rep = await evalJs(`new Promise(function(resolve){ window.__ctOnMessage({type:'replace-all'},null,function(r){ setTimeout(function(){
    var hero=document.querySelector('.hero');
    function q(s){return document.querySelector(s);}
    var out={ ret:{total:r.total,success:r.success,fail:r.fail},
      heroCols: hero?hero.querySelectorAll('.col').length:0,
      heroPs: hero?hero.querySelectorAll('p').length:0,
      heroItselfReplaced: hero?hero.classList.contains('ct-replaced'):null,
      heroReplMain: hero?hero.querySelectorAll(':scope > .ct-repl-main').length:-1,
      heroLeafReplaced: hero?Array.prototype.map.call(hero.querySelectorAll('p'),function(p){return p.classList.contains('ct-replaced')&&!!p.querySelector('.ct-repl-main');}):[],
      leafReplaced: ['leaf1','leaf2'].map(function(id){var el=document.getElementById(id);return el&&el.classList.contains('ct-replaced')&&!!el.querySelector('.ct-repl-main');}),
      singleDivOk: (function(){var el=document.getElementById('singlediv');return !!(el&&el.classList.contains('ct-replaced')&&el.querySelector('.ct-repl-main'));})(),
      withlinkReplaced: (function(){var el=document.getElementById('withlink');return !!(el&&el.classList.contains('ct-replaced')&&el.querySelector('.ct-repl-main'));})(),
      linkKept: !!q('#withlink a'),
      doubleTranslated: (function(){var n=0;document.querySelectorAll('.ct-replaced').forEach(function(el){if(el.parentElement&&el.parentElement.closest&&el.parentElement.closest('.ct-replaced'))n++;});return n;})()
    }; resolve(out); },900); }); })`, true);
  const p1 = rep.heroCols===2 && rep.heroPs===4 && rep.heroItselfReplaced===false && rep.heroReplMain===0 &&
    rep.heroLeafReplaced.every(Boolean) && rep.leafReplaced.every(Boolean) && rep.singleDivOk && rep.withlinkReplaced && rep.linkKept && rep.doubleTranslated===0;
  console.log((p1?'✅':'❌')+' 用例1 replace 不破框架:', JSON.stringify(rep));

  // 用例2: remove-all 还原
  const rst = await evalJs(`new Promise(function(resolve){ window.__ctOnMessage({type:'remove-all'},null,function(){ setTimeout(function(){
    resolve({ leaf1Text:(document.getElementById('leaf1')||{}).textContent?.trim(),
      heroPText:(document.querySelector('.hero .col p')||{}).textContent?.trim(),
      leftOver: document.querySelectorAll('.ct-replaced, .ct-repl-main, .ct-bi, .ct-target').length });
  },300); }); })`, true);
  const p2 = rst.leaf1Text==='This is a standalone paragraph with enough text to translate.' &&
    rst.heroPText==='Welcome to our community chat platform for everyone.' && rst.leftOver===0;
  console.log((p2?'✅':'❌')+' 用例2 remove-all 还原:', JSON.stringify(rst));

  // 用例3: bilingual 回归
  const bi = await evalJs(`new Promise(function(resolve){ window.__ctOnMessage({type:'translate-all'},null,function(){ setTimeout(function(){
    var leaf1=document.getElementById('leaf1');
    resolve({ leaf1Bilingual: leaf1?leaf1.classList.contains('ct-bilingual'):null,
      leaf1Target: leaf1?!!leaf1.querySelector('.ct-target'):null,
      heroPsBilingual: Array.prototype.filter.call(document.querySelectorAll('.hero p'),function(p){return p.classList.contains('ct-bilingual');}).length,
      heroStructureKept: document.querySelectorAll('.hero .col').length===2 });
  },800); }); })`, true);
  const p3 = bi.leaf1Bilingual===true && bi.leaf1Target===true && bi.heroPsBilingual===4 && bi.heroStructureKept===true;
  console.log((p3?'✅':'❌')+' 用例3 bilingual 回归:', JSON.stringify(bi));

  const all = p1 && p2 && p3;
  console.log(all ? '\n🎉 全部通过' : '\n⚠️ 有用例失败');
  process.exit(all ? 0 : 1);
}
main().catch((e) => { console.error('运行出错:', e.message); process.exit(2); });
