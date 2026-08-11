# 真机验证:custom-hover-translate 的 replace(仅译文)模式在真实页面上是否破框架。
# 通道:扩展 service worker → chrome.tabs.sendMessage(tabId, {type:'replace-all'}) → content.js。
#       真实翻译走扩展内引擎(默认 google_gtx 免 key,需联网)。
# 用法: python verify-realpage.py [cdpPort] [urlHint]
#   默认连 9222(手动装扩展 + 调试端口重启的 SecBrowser),找 RumbleTalk 演示页。
# 退出码: 0=通过, 1=破框架/双重翻译, 2=找不到页/扩展, 3=content script 未注入, 4=翻译未生效。
import json, sys, time, urllib.request
import websocket  # websocket-client

CDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
URL_HINT = sys.argv[2] if len(sys.argv) > 2 else 'html-group-chat'

def http_json(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}{path}', timeout=6) as r:
        return json.loads(r.read().decode('utf-8'))

class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self._id = 0
    def call(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({'id': self._id, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self._id:
                if 'error' in msg: raise RuntimeError(msg['error'])
                return msg.get('result', {})
    def eval(self, expr, await_promise=False):
        r = self.call('Runtime.evaluate', {'expression': expr, 'awaitPromise': await_promise, 'returnByValue': True})
        if 'exceptionDetails' in r:
            ex = r['exceptionDetails'].get('exception', {})
            raise RuntimeError('页面/worker 异常: ' + str(ex.get('description') or r['exceptionDetails'].get('text'))[:300])
        return r.get('result', {}).get('value')
    def close(self):
        try: self.ws.close()
        except Exception: pass

def find_target(pred, desc):
    for t in http_json('/json'):
        if pred(t): return t
    return None

# 1) 找目标页面
page = find_target(lambda t: t.get('type') == 'page' and URL_HINT in (t.get('url') or ''), 'page')
if not page:
    print('找不到目标页,url hint =', URL_HINT)
    print('当前 page targets:')
    for t in http_json('/json'):
        if t.get('type') == 'page': print('  ', t.get('url'))
    sys.exit(2)
print('目标页:', page['url'])

# 2) 找 custom-hover-translate 的 service worker(可能休眠,先触发)
def find_worker():
    for t in http_json('/json'):
        u = t.get('url') or ''
        if t.get('type') == 'service_worker' and '/src/background.js' in u:
            return t
    return None

worker = find_worker()
if not worker:
    # worker 休眠:列出所有 sw 帮诊断
    sws = [t.get('url') for t in http_json('/json') if t.get('type') == 'service_worker']
    print('未找到 custom-hover-translate 的 service worker(/src/background.js)。')
    print('当前 service workers:', sws or '(无 — 可能全部休眠)')
    print('→ 确认扩展已安装并启用;可先访问任意 https 页面唤醒 worker 后重试。')
    sys.exit(2)
print('扩展 worker:', worker['url'])

wc = CDP(worker['webSocketDebuggerUrl'])
wc.call('Runtime.enable')
mname = wc.eval('chrome.runtime.getManifest().name')
print('扩展名:', mname)

# 3) 用 worker 找页面 tabId,确认 content script 已注入(发 ping)
#    content.js 没有 ping 处理器,直接发 replace-all 前先看 tabs
tabs = wc.eval('new Promise(function(res){ chrome.tabs.query({}, function(ts){ res(ts.map(function(t){return {id:t.id,url:t.url||""};})); }); })', await_promise=True)
tab = next((t for t in (tabs or []) if URL_HINT in t.get('url', '')), None)
if not tab:
    print('chrome.tabs 里找不到目标 tab。tabs=', json.dumps(tabs, ensure_ascii=False)[:400])
    wc.close(); sys.exit(2)
tab_id = tab['id']
print('目标 tabId:', tab_id)

# 4) 通过 worker 发 replace-all 给 content script
#    content.js 的 onMessage 处理 replace-all → translateAllReplace() → sendResponse(结果)
print('\\n触发 replace-all(真实翻译,走 google_gtx,需联网,可能 10-30s)...')
resp = wc.eval(
    'new Promise(function(res){ chrome.tabs.sendMessage(%d, {type:"replace-all"}, function(r){ res(r || {__noResponse: chrome.runtime.lastError && chrome.runtime.lastError.message}); }); })' % tab_id,
    await_promise=True)
if resp is None or (isinstance(resp, dict) and resp.get('__noResponse')):
    print('content script 未响应 replace-all:', resp)
    print('→ content script 可能未注入此页(扩展未启用/站点权限不足)。')
    wc.close(); sys.exit(3)
print('replace-all 返回:', json.dumps({k: resp.get(k) for k in ('total','success','fail','provider','model','message')}, ensure_ascii=False))

# 5) 等注入稳定,在页面主世界读 DOM 断言(content script 注入的类名是 DOM 可见的)
time.sleep(2)
pc = CDP(page['webSocketDebuggerUrl'])
pc.call('Runtime.enable')
check = pc.eval('''(function(){
  var containerReplaced = 0, leafReplaced = 0, doubleT = 0;
  var repls = document.querySelectorAll('.ct-replaced');
  repls.forEach(function(el){
    var hasBlockChild = el.querySelector('p,li,div,section,article,ul,ol,h1,h2,h3,h4,h5,h6,table');
    if (hasBlockChild) containerReplaced++; else leafReplaced++;
    if (el.parentElement && el.parentElement.closest && el.parentElement.closest('.ct-replaced')) doubleT++;
  });
  return { totalReplaced: repls.length, containerReplaced: containerReplaced,
           leafReplaced: leafReplaced, doubleTranslated: doubleT };
})()''')
print('\\n=== DOM 断言 ===')
print(json.dumps(check, ensure_ascii=False))
wc.close(); pc.close()

if check['totalReplaced'] == 0:
    print('\\n⚠️ 页面无 .ct-replaced —— 翻译未生效(可能引擎未译出/全部被过滤)。')
    sys.exit(4)
ok = check['containerReplaced'] == 0 and check['doubleTranslated'] == 0 and check['leafReplaced'] > 0
print('\\n' + ('✅ 真机验证通过:无容器整块顶替(破框架)、无双重翻译、%d 个叶子段已替换' % check['leafReplaced'] if ok
               else '❌ 仍有破框架或双重翻译,见上'))
sys.exit(0 if ok else 1)
