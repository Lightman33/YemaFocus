// 只在进程内把 GitHub HTTP 形状接到 MemoryTransport；不发真实网络请求。
import { encodeBase64, decodeBase64 } from '../../transport/transport.js';
export function githubDouble(memory) {
  let next = null;
  const requests = [];
  return { requests, failNext(status, headers = {}) { next = { status, headers }; },
    async fetch(url, options = {}) {
      requests.push({ url, method: options.method || 'GET' });
      if (next) { const failure = next; next = null; return new Response('{}', failure); }
      const parts = new URL(url).pathname.split('/contents/');
      if (parts.length === 1) return Response.json({ private: true });
      const path = parts[1].split('/').map(decodeURIComponent).join('/');
      try {
        if (options.method === 'PUT') { await memory.put(path, decodeBase64(JSON.parse(options.body).content)); return Response.json({ content: { sha: 'a'.repeat(40) } }); }
        if (options.method === 'DELETE') { await memory.remove(path); return Response.json({}); }
        if (!path) return Response.json([]);
        let bytes;
        try { bytes = await memory.get(path); } catch (e) { if (e.code !== 'notfound') throw e; }
        if (bytes) return Response.json({ type: 'file', sha: 'a'.repeat(40), size: bytes.length, encoding: 'base64', content: encodeBase64(bytes) });
        return Response.json((await memory.list(path)).map(e => ({ ...e, type: 'file', sha: 'a'.repeat(40) })));
      } catch (e) { return Response.json({}, { status: e.code === 'notfound' ? 404 : 500 }); }
    }
  };
}
