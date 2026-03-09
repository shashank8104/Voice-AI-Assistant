"""
Run the Voice Assistant server with WebSocket ping disabled.
Works both locally and on Render (reads $PORT/$HOST from environment).

Usage:
    python run_server.py
"""
import os
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", 8000)),
        reload=False,              # Keep reload=False for production (Render)
        ws_ping_interval=None,     # Disable WebSocket keepalive pings → prevents 1011 errors
        ws_ping_timeout=None,
    )
