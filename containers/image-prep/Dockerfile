# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    U2NET_HOME=/app/models \
    NUMBA_CACHE_DIR=/app/numba-cache \
    MPLCONFIGDIR=/tmp/mpl-cache

# libgomp1 = OpenMP runtime onnxruntime + numpy link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Eager model fetch + numba-cache warmup. Two things bake into the image layer
# here, both load-bearing for cold-start:
#   1. u2net.onnx (~170 MB) under U2NET_HOME=/app/models, so the first request
#      doesn't pay the model download (rembg reads U2NET_HOME, not REMBG_HOME).
#   2. pymatting's numba kernels. `import rembg` pulls in pymatting, which
#      JIT-compiles ~46s of numba kernels on a COLD cache. With NUMBA_CACHE_DIR
#      on the ephemeral /tmp that recompile happened on every cold start and
#      blew past the container runtime's port-ready window ("not listening on
#      :8000"). Pointing NUMBA_CACHE_DIR at /app/numba-cache (an image-layer
#      path) persists the compiled .nbi cache into the image.
#
# The `touch` is the subtle, load-bearing part: numba stamps each cache entry
# with the source file's full-precision st_mtime (e.g. ...078.137631), but
# buildkit truncates mtimes to whole seconds when it exports the layer
# (...078.0) at runtime. The sub-second mismatch invalidates EVERY kernel and
# forces a full 46s recompile on first import despite the baked cache. Pinning
# pymatting's sources to a whole-second mtime first makes the baked stamp match
# what the runtime sees, so the cache actually loads (~1.5s import). The import
# is also deferred off module-load in app.py as a second line of defense.
RUN find /usr/local/lib/python3.11/site-packages/pymatting -name '*.py' -exec touch -d '@1700000000' {} + \
    && python -c "from rembg import new_session; new_session('u2net'); print('rembg warm OK')" \
    && test -d /app/numba-cache && echo "numba cache baked: $(find /app/numba-cache -name '*.nbi' | wc -l) kernels"

COPY app.py .

EXPOSE 8000
CMD ["python", "app.py"]
