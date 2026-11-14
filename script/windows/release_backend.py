"""Entry point for the bundled Windows backend and its desktop worker."""

import os
import sys
from threading import Thread


def main():
    """Run the selected worker or serve the console until its parent closes the pipe."""
    if sys.argv[1:] == ['--desktop-worker']:
        from autorush.drivers.desktop.worker import main as run_worker

        run_worker()
        return

    import uvicorn
    from autorush.api.app import app

    headers = [('X-Autorush-Release', 'windows')]
    if instance := os.environ.get('AUTORUSH_RELEASE_INSTANCE'):
        headers.append(('X-Autorush-Instance', instance))
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=int(os.environ['AUTORUSH_BACKEND_PORT']),
        ws='websockets', access_log=False, headers=headers, timeout_graceful_shutdown=5))

    def stop_with_parent():
        """Request graceful shutdown when Electron exits or closes standard input."""
        sys.stdin.buffer.read(1)
        server.should_exit = True

    if not sys.stdin.isatty():
        Thread(target=stop_with_parent, daemon=True).start()
    server.run()


if __name__ == '__main__':
    main()
