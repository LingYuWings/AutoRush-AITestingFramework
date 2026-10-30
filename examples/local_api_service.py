"""Independent loopback-only API playground. Run: python examples/local_api_service.py."""
import argparse
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def reply(self, status, value=None, content_type='application/json', headers=None):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        if status in {204, 304}: body = b''
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        for key, item in (headers or {}).items(): self.send_header(key, item)
        self.end_headers()
        if self.command != 'HEAD':
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass

    def handle_request(self):
        path = urlsplit(self.path).path
        query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 1048576: return self.reply(413, {'error': 'body limit 1 MiB'})
            body = self.rfile.read(length)
            try: data = json.loads(body) if body else {}
            except (ValueError, UnicodeError): data = None
            if path == '/health': return self.reply(200, {'status': 'ok'})
            if path == '/echo': return self.reply(200, {'method': self.command, 'query': query, 'headers': dict(self.headers), 'json': data, 'body_text': body.decode(errors='replace'), 'body_sha256': hashlib.sha256(body).hexdigest()})
            if path == '/login' and self.command == 'POST':
                if data != {'username': 'demo', 'password': 'demo'}: return self.reply(401, {'error': 'invalid demo credentials'})
                token = uuid4().hex
                with self.server.lock: self.server.tokens.add(token)
                return self.reply(200, {'token': token}, headers={'Set-Cookie': 'session='+token+'; Path=/; HttpOnly'})
            if path == '/delay':
                seconds = float(query.get('seconds', ['0.2'])[0])
                if not 0 <= seconds <= 2: return self.reply(422, {'error': 'delay must be 0..2 seconds'})
                time.sleep(seconds)
                return self.reply(200, {'delayed': seconds})
            if path.startswith('/status/'):
                status = int(path.rsplit('/', 1)[1])
                if not 200 <= status <= 599: return self.reply(422, {'error': 'status must be 200..599'})
                return self.reply(status, {'status': status})
            if path == '/redirect': return self.reply(302, {}, headers={'Location': '/health'})
            if path == '/text': return self.reply(200, b'Local API fixture', 'text/plain')
            if path == '/large': return self.reply(200, b'x'*1100000, 'application/octet-stream')
            if path == '/products': return self.reply(200, {'items': [{'id': 1, 'name': 'Demo item', 'price': 20}]})
            if path == '/protected' or path == '/orders' or path.startswith('/orders/'):
                authorization = self.headers.get('Authorization', '')
                scheme, _, token = authorization.partition(' ')
                if scheme.lower() != 'bearer' or not token or token.strip() != token: return self.reply(401, {'error': 'Bearer token required'})
                with self.server.lock: authorized = token in self.server.tokens
                if not authorized: return self.reply(401, {'error': 'Bearer token required'})
                if path == '/protected': return self.reply(200, {'authorized': True})
                with self.server.lock:
                    if path == '/orders' and self.command == 'GET': return self.reply(200, {'items': list(self.server.orders.values())})
                    if path == '/orders' and self.command == 'POST':
                        if not isinstance(data, dict) or data.get('product_id') != 1 or type(data.get('quantity')) is not int or not 1 <= data['quantity'] <= 100: return self.reply(422, {'error': 'product_id=1 and quantity integer 1..100 required'})
                        order = {'id': uuid4().hex, 'product_id': 1, 'quantity': data['quantity'], 'total': 20*data['quantity']}
                        self.server.orders[order['id']] = order
                        return self.reply(201, order)
                    order_id = path.rsplit('/', 1)[1]
                    order = self.server.orders.get(order_id)
                    if order is None: return self.reply(404, {'error': 'order not found'})
                    if self.command == 'GET': return self.reply(200, order)
                    if self.command == 'DELETE':
                        del self.server.orders[order_id]
                        return self.reply(204)
                    if self.command in {'PATCH', 'PUT'}:
                        if not isinstance(data, dict) or type(data.get('quantity')) is not int or not 1 <= data['quantity'] <= 100: return self.reply(422, {'error': 'quantity integer 1..100 required'})
                        order.update(quantity=data['quantity'], total=20*data['quantity'])
                        return self.reply(200, order)
                return self.reply(405, {'error': 'method not allowed'})
            return self.reply(404, {'error': 'route not found'})
        except (ValueError, OverflowError): self.reply(422, {'error': 'invalid input'})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = handle_request


def create_server(port=8765):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.orders, server.tokens, server.lock = {}, set(), threading.RLock()
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = create_server(args.port)
    print(f'Local API playground: http://127.0.0.1:{server.server_port} (demo/demo)', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
