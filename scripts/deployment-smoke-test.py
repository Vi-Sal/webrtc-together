"""Run against the packaged app with PORT=10000; uses only Python's standard library."""
import base64
import json
import os
import socket
import urllib.request

port = int(os.environ.get("TEST_PORT", "10000"))
base = f"http://127.0.0.1:{port}"
with urllib.request.urlopen(base + "/healthz", timeout=10) as response:
    assert json.load(response) == {"status": "UP"}
with urllib.request.urlopen(base + "/", timeout=10) as response:
    assert b"/js/app.js" in response.read()
print("PASS: configured port serves health and the bundled frontend.")


def handshake(origin):
    key = base64.b64encode(os.urandom(16)).decode()
    headers = [
        "GET /ws/rooms HTTP/1.1",
        f"Host: 127.0.0.1:{port}",
        "Connection: Upgrade", "Upgrade: websocket",
        "Sec-WebSocket-Version: 13", f"Sec-WebSocket-Key: {key}",
        "X-Forwarded-Proto: https", "X-Forwarded-Host: calls.example.test",
        "X-Forwarded-Port: 443", f"Origin: {origin}", "", "",
    ]
    with socket.create_connection(("127.0.0.1", port), timeout=10) as client:
        client.sendall("\r\n".join(headers).encode())
        response = client.recv(4096).decode()
        return response.split("\r\n", 1)[0]


assert " 101 " in handshake("https://calls.example.test")
assert " 403 " in handshake("https://unrelated.example.test")
print("PASS: HTTPS proxy WebSocket upgrade works; unrelated origins remain rejected.")
