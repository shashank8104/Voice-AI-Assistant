"""
Run the Voice Assistant server with WebSocket ping disabled.
Use this instead of `uvicorn backend.main:app --reload`
to avoid the `1011 keepalive ping timeout` error.

Usage:
    python run_server.py
"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        ws_ping_interval=None,  # Disable WebSocket keepalive pings → prevents 1011 errors
        ws_ping_timeout=None,
    )
