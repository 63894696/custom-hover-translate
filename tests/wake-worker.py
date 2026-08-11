# 唤醒 MV3 service worker:临时开一个 https 页(content script 注入会拉起 worker),
# 等 worker 出现在 /json,然后关掉临时页。
import json, sys, time, urllib.request
import websocket

CDP_PORT = 9222

def http_json(path, method='GET'):
    req = urllib.request.Request(f'http://127.0.0.1:{CDP_PORT}{path}', method=method)
    with urllib.request.urlopen(req, timeout=6) as r:
        return json.loads(r.read().decode('utf-8'))

# 浏览器级 ws:用 Target.createTarget 开页
ver = http_json('/json/version')
bws = websocket.create_connection(ver['webSocketDebuggerUrl'], timeout=15, suppress_origin=True)
_id = 0
def call(method, params=None):
    global _id
    _id += 1
    bws.send(json.dumps({'id': _id, 'method': method, 'params': params or {}}))
    while True:
        m = json.loads(bws.recv())
        if m.get('id') == _id:
            if 'error' in m: raise RuntimeError(m['error'])
            return m.get('result', {})

t = call('Target.createTarget', {'url': 'https://example.com/'})
tid = t['targetId']
print('临时页已开:', tid)

# 轮询 worker 出现(url 为空也认:type=service_worker 且非空 target)
worker = None
for i in range(20):
    for tg in http_json('/json'):
        u = tg.get('url') or ''
        if tg.get('type') == 'service_worker' and ('/src/background.js' in u or not u):
            worker = tg; break
    if worker: break
    time.sleep(0.5)

# 关临时页
try: call('Target.closeTarget', {'targetId': tid})
except Exception as e: print('关页失败(无害):', e)
bws.close()

if worker:
    print('✅ worker 已唤醒:', worker['url'])
    sys.exit(0)
print('❌ 等待 10s 仍无 worker — 扩展可能未启用')
sys.exit(2)
