const { LRUCache } = require('lru-cache');
const config = require('./config');

const store = new LRUCache({
  max: config.cacheMaxItems,
  // Size-aware eviction for binary items (images)
  maxSize: 512 * 1024 * 1024, // 512 MB max total size
  sizeCalculation: (value) => {
    if (Buffer.isBuffer(value?.data)) return value.data.length;
    if (typeof value?.data === 'string') return Buffer.byteLength(value.data);
    if (typeof value === 'string') return Buffer.byteLength(value);
    return 1024; // default 1 KB estimate
  },
});

/**
 * @param {string} key
 * @param {*} value
 * @param {number} ttlSeconds
 */
function set(key, value, ttlSeconds) {
  store.set(key, value, { ttl: ttlSeconds * 1000 });
}

/**
 * @param {string} key
 * @returns {*|undefined}
 */
function get(key) {
  return store.get(key);
}

function del(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

function stats() {
  return { size: store.size, calculatedSize: store.calculatedSize };
}

module.exports = { set, get, del, clear, stats };
