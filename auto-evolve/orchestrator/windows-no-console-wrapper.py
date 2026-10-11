import json
import os
import subprocess
import sys
import threading


def pump(source, target_fd):
    while True:
        chunk = source.read(65536)
        if not chunk:
            break
        os.write(target_fd, chunk)


def main():
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    env = os.environ.copy()
    for key, value in (payload.get("env") or {}).items():
        if value is None:
            env.pop(str(key), None)
        else:
            env[str(key)] = str(value)
    stdin_text = payload.get("stdin_text")
    process = subprocess.Popen(
        payload["command"],
        cwd=payload.get("cwd") or None,
        env=env,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    stdout_thread = threading.Thread(target=pump, args=(process.stdout, 1), daemon=True)
    stderr_thread = threading.Thread(target=pump, args=(process.stderr, 2), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    if process.stdin is not None:
        process.stdin.write(str(stdin_text).encode("utf-8"))
        process.stdin.close()
    exit_code = process.wait()
    stdout_thread.join()
    stderr_thread.join()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
