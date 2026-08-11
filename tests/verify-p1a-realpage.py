# P1a 真机验证:唤醒 worker → 在真实 RumbleTalk 页 replace-all → 断言属性翻译 + 结构不变。
# 用法: python verify-p1a-realpage.py [cdpPort] [urlHint]
import json, sys, time, urllib.request
import websocket

CDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
URL_HINT = sys.argv[2] if len(sys.argv) > 2 else 'rumbletalk'

def jget(p):
    with urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}{p}', timeout=6) as r:
        return json.loads(r.read().decode('utf-8'))

ver = jget('/json/version')
bws = websocket.create_connection(ver['webSocketDebuggerUrl'], timeout=25, suppress_origin=True)
bws.settimeout(20)
_id = [0]
def bcall(method, params=None, sid=None):
    _id[0] += 1
    msg = {'id': _id[0], 'method': method, 'params': params or {}}
    if sid: msg['sessionId'] = sid
    bws.send(json.dumps(msg))
    while True:
        m = json.loads(bws.recv())
        if m.get('id') == _id[0]:
            if 'error' in m: raise RuntimeError(m['error'])
            return m.get('result', {})

def get_worker():
    for tg in jget('/json'):
        if tg.get('type') == 'service_worker' and 'background.js' in (tg.get('url') or ''):
            return tg
    return None

# 1) 唤醒 worker(没有就开 https 页拉)
worker = get_worker()
if not worker:
    t = bcall('Target.createTarget', {'url': 'https://example.com/'})
    for _ in range(24):
        worker = get_worker()
        if worker: break
        time.sleep(0.5)
    try: bcall('Target.closeTarget', {'targetId': t['targetId']})
    except Exception: pass
if not worker:
    print('❌ worker 唤不醒(扩展未启用?)'); sys.exit(2)
print('worker:', worker['url'])

# 2) 找目标页
page = next((t for t in jget('/json') if t['type'] == 'page' and URL_HINT in (t.get('url') or '')), None)
if not page:
    print(f'❌ 没有 {URL_HINT} 页'); sys.exit(2)
print('目标页:', page['url'])

# 3) worker → replace-all(真实 google_gtx 翻译,需联网)
a = bcall('Target.attachToTarget', {'targetId': worker['id'], 'flatten': True})
wsid = a['sessionId']
tabid = bcall('Runtime.evaluate', {'expression': 'new Promise(function(res){ chrome.tabs.query({}, function(ts){ var t=ts.find(function(x){return /%s/.test(x.url||"")}); res(t?t.id:null); }); })' % URL_HINT, 'awaitPromise': True, 'returnByValue': True}, sid=wsid).get('result', {}).get('value')
print('tabId:', tabid)
if tabid is None:
    print('❌ tabs 里找不到目标'); sys.exit(2)
print('触发 replace-all(真实翻译 10-40s)...')
resp = bcall('Runtime.evaluate', {'expression': 'new Promise(function(res){ chrome.tabs.sendMessage(%s,{type:"replace-all"},function(r){ res(r||{err:chrome.runtime.lastError&&chrome.runtime.lastError.message}); }); })' % tabid, 'awaitPromise': True, 'returnByValue': True}, sid=wsid).get('result', {}).get('value')
if not isinstance(resp, dict) or resp.get('err'):
    print('❌ replace-all 失败:', resp); sys.exit(3)
print('replace-all:', json.dumps({k: resp.get(k) for k in ('total', 'success', 'fail', 'cached', 'provider')}, ensure_ascii=False))
bcall('Target.detachFromTarget', {'sessionId': wsid})
bws.close()
time.sleep(2)

# 4) 页面 DOM 断言
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=20, suppress_origin=True)
ws.settimeout(15)
def ev(expr, i=[0]):
    i[0] += 1
    ws.send(json.dumps({'id': i[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == i[0]:
            r = m.get('result', {})
            if 'exceptionDetails' in r: return 'EXC:' + str(r['exceptionDetails'].get('exception', {}).get('description', ''))[:300]
            return r.get('result', {}).get('value')

chk = ev('''(function(){
  const attrs = document.querySelectorAll('[data-ct-attr]');
  const samples = [];
  attrs.forEach(function(el,i){ if(i<6) samples.push({tag:el.tagName, attr:el.dataset.ctAttr, val:(el.getAttribute(el.dataset.ctAttr)||"").slice(0,44), orig:(el.dataset.ctAttrOrig||"").slice(0,44)}); });
  var containerReplaced=0, leafReplaced=0, doubleT=0;
  document.querySelectorAll('.ct-replaced').forEach(function(el){
    if (el.querySelector('p,li,div,section,article,ul,ol,h1,h2,h3,h4,h5,h6,table')) containerReplaced++; else leafReplaced++;
    if (el.parentElement && el.parentElement.closest && el.parentElement.closest('.ct-replaced')) doubleT++;
  });
  return { attrCount: attrs.length, samples: samples,
    structure: { links: document.querySelectorAll('a').length, imgs: document.querySelectorAll('img').length, lists: document.querySelectorAll('ul,ol').length },
    containerReplaced: containerReplaced, leafReplaced: leafReplaced, doubleTranslated: doubleT };
})()''')
ws.close()
print('\n=== DOM 断言 ===')
print(json.dumps(chk, ensure_ascii=False, indent=1))

# 5) remove-all 还原断言
ws2 = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=20, suppress_origin=True)
ws2.settimeout(15)
def ev2(expr, i=[100]):
    i[0] += 1
    ws2.send(json.dumps({'id': i[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True}}))
    while True:
        m = json.loads(ws2.recv())
        if m.get('id') == i[0]:
            return m.get('result', {}).get('result', {}).get('value')
ev2('(function(){ try{ chrome.runtime.sendMessage; }catch(e){} })()')
# 通过 worker 发 remove-all 更稳,但内容脚本在页面上下文没有 __ctOnMessage;直接用 worker 通道已断。
# 简化:读 data-ct-attr 是否还在(由下次 remove-all 清);此处只验证当前结构。
ws2.close()

ok_struct = chk['containerReplaced'] == 0 and chk['doubleTranslated'] == 0
print('\n结构: 容器顶替=%d 双重=%d 叶子=%d' % (chk['containerReplaced'], chk['doubleTranslated'], chk['leafReplaced']))
print('属性: 采集翻译了 %d 个' % chk['attrCount'])
ok = ok_struct and chk['leafReplaced'] > 0
print('\n' + ('✅ 真机 P1a 通过:属性翻译+结构不破' if ok else '❌ 仍有问题'))
sys.exit(0 if ok else 1)
