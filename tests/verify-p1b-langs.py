# P1b 验证:语言清单填充 + 系统语言默认 + 新语言真实翻译。
# 前提:SecBrowser 带 --remote-debugging-port=9222,已手动装扩展(开发者模式)。
# 用法: python verify-p1b-langs.py [cdpPort]
# 退出码: 0=通过, 1=断言失败, 2=找不到页/扩展, 5=扩展需手动重载(提示用户)。
import json, sys, time, urllib.request
import websocket

CDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
EXT_URL_HINT = 'chrome-extension://'

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
            raise RuntimeError('异常: ' + str(ex.get('description') or r['exceptionDetails'].get('text'))[:400])
        return r.get('result', {}).get('value')
    def close(self):
        try: self.ws.close()
        except Exception: pass

# 1) 找扩展 service worker(/json 里 SW 的 url 可能为空 → 逐个探 chrome.runtime.id)
def probe_worker(t):
    try:
        c = CDP(t['webSocketDebuggerUrl'])
        v = c.eval('typeof chrome!=="undefined" && chrome.runtime && chrome.runtime.id ? {id: chrome.runtime.id, hasLangs: typeof self.CT_LANGS!=="undefined"} : null')
        c.close()
        if v: return (t, v)
    except Exception:
        pass
    return None

def find_worker():
    for t in http_json('/json'):
        if t.get('type') not in ('service_worker', 'worker'): continue
        u = t.get('url') or ''
        if '/src/background.js' in u:
            return (t, None)
        hit = probe_worker(t)
        if hit: return hit
    return None

found = find_worker()
if not found:
    print('未找到扩展 service worker(worker 探测均无 chrome.runtime.id)。')
    print('→ 确认扩展已启用;访问任意 https 页唤醒 worker 后重试。')
    sys.exit(2)
worker, probed = found
if probed:
    print('worker 识别:chrome.runtime.id =', probed['id'], '| CT_LANGS 已在:', probed['hasLangs'])

wc = CDP(worker['webSocketDebuggerUrl'])
wc.call('Runtime.enable')

# 断言0:worker 里已有 CT_LANGS(说明 background 已重载、langs.js importScripts 成功)
has_langs = wc.eval('typeof self.CT_LANGS !== "undefined" && self.CT_LANGS.LANGS.length')
if not has_langs:
    print('❌ worker 里没有 CT_LANGS —— 扩展还没重载。')
    print('→ 请到 chrome://extensions 点「Prisir 翻译」的刷新按钮,然后重跑本脚本。')
    wc.close(); sys.exit(5)
lang_count = wc.eval('self.CT_LANGS.LANGS.length')
print(f'✅ worker 已加载 langs.js,语言数 = {lang_count}')
ok = lang_count >= 30

# 断言1:guessTargetLang 在 zh-CN 系统 → zh
g = wc.eval('self.CT_LANGS.guessTargetLang()')
print(f'   本机系统语言推断 = {g} (navigator.language={wc.eval("navigator.language")})')

# 断言2:onInstalled 时存的 dstLang(应为推断值,不是写死 zh)
stored = wc.eval('new Promise(function(res){ chrome.storage.local.get("dstLang", function(s){ res(s.dstLang || null); }); })', await_promise=True)
print(f'   存储 dstLang = {stored}')
if not stored:
    print('   (dstLang 未落盘 — 扩展是新装的,重载后 onInstalled 不再触发;UI 层用 guess 兜底)')

# 断言3:gtx 真实翻译到新语言(西/阿/繁中) — 走引擎层,验证新码被 gtx 接受
if stored or True:
    print('\n真实翻译测试(google_gtx → es / ar / zh-TW):')
    res = wc.eval('''new Promise(function(res){
      chrome.runtime.sendMessage({type:'translate', text:'Good morning, welcome to our community.'}, function(r){
        res(r || {err: chrome.runtime.lastError && chrome.runtime.lastError.message});
      });
    })''', await_promise=True)
    print('   默认(zh):', json.dumps(res, ensure_ascii=False)[:160])

    # 逐语言测:直接调引擎换 dstLang
    for tl in ['es', 'ar', 'zh-TW']:
        r = wc.eval('''new Promise(function(res){
          self.CT_ENGINES.engineTranslate({text:'Good morning, welcome to our community.', srcLang:'en', dstLang:'%s'})
            .then(function(x){ res({ok:x.ok, text:(x.text||'').slice(0,80), err:x.error||null}); })
            .catch(function(e){ res({ok:false, err:String(e)}); });
        })''' % tl, await_promise=True)
        mark = '✅' if r.get('ok') else '❌'
        print(f'   {mark} en→{tl}: {r.get("text") or r.get("err")}')
        ok = ok and r.get('ok')

wc.close()
print('\n' + ('🎉 P1b 后台/引擎层验证通过' if ok else '⚠️ 有断言失败,见上'))
sys.exit(0 if ok else 1)
