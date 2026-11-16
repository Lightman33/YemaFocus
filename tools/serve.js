// 仅提供 web/ 内的静态资源，不代理 GitHub、不接收令牌、不写数据。
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

export function createPreviewServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('只支持读取静态网页');
      return;
    }
    try {
      // 固定基址只用于解析；不把来路 Host 拼进路径或转发到外站。
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const parts = pathname.split('/').filter(Boolean);
      if (parts.some(part => part.startsWith('.') || part.includes('\\')) || ['tools', 'tests'].includes(parts[0])) {
        response.writeHead(403); response.end('不提供此文件'); return;
      }
      const target = await realpath(resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname)));
      const rel = relative(await realpath(ROOT), target);
      if (rel === '..' || rel.startsWith('..' + sep) || resolve(ROOT, rel) !== target || !(await stat(target)).isFile()) {
        response.writeHead(403); response.end('不提供此文件'); return;
      }
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('找不到网页文件');
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createPreviewServer();
  server.once('error', () => { console.error('预览服务未能启动，请检查 8765 端口是否被占用。'); process.exitCode = 1; });
  server.listen(8765, '127.0.0.1', () => console.log('本机预览已启动：http://localhost:8765 （按 Ctrl+C 关闭）'));
}
