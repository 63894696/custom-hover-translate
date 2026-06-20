// 30 行 LRU + TTL。
//  - Map 顺序天然按插入排,get 时先 delete 再 set 实现 LRU。
//  - 命中后立即续期 TTL(get 时刷新时间戳)。

export class LRU {
  constructor({ max = 400, ttlMs = 24 * 3600 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.m = new Map(); // key -> { value, exp }
  }
  get(key) {
    const hit = this.m.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    // 续 LRU 顺序:删了重插
    this.m.delete(key);
    this.m.set(key, hit);
    return hit.value;
  }
  set(key, value, ttlMs = this.ttlMs) {
    if (this.m.has(key)) this.m.delete(key);
    this.m.set(key, { value, exp: Date.now() + ttlMs });
    while (this.m.size > this.max) {
      const first = this.m.keys().next().value;
      this.m.delete(first);
    }
  }
  clear() {
    this.m.clear();
  }
  get size() {
    return this.m.size;
  }
}

// 32-bit 哈希(crc32 简版),足够散 key 即可,不用密码学强度。
export function cyrb32(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  // 转无符号 32-bit 十六进制
  return (h >>> 0).toString(16);
}
