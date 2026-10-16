import json
import os
import subprocess
import sys
import threading


def process_cwd(value):
    if not value or os.name != "nt" or len(value) < 248:
        return value or None
    import ctypes
    from ctypes import wintypes

    # 长目录仅换成同一物理目录的短名，绝不回退父目录扩大权限。
    short_name = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
    short_name.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    short_name.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    count = short_name(os.path.abspath(value), buffer, len(buffer))
    if not count or count >= len(buffer) or len(buffer.value) >= 248:
        raise OSError("Working directory exceeds Windows process limit; no usable short name")
    if not os.path.samefile(value, buffer.value):
        raise OSError("Short working directory does not match requested directory")
    return buffer.value


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
        cwd=process_cwd(payload.get("cwd")),
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
