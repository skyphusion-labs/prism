# syntax=docker/dockerfile:1
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    U2NET_HOME=/app/models \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    MPLCONFIGDIR=/tmp/mpl-cache

# libgomp1 = OpenMP runtime onnxruntime + numpy link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Eager model fetch + warmup: u2net is ~170 MB. Baking the session at build
# time means the first request lands on a warm ORT session instead of paying
# the download + init on first hit. U2NET_HOME=/app/models is an absolute path
# baked into the image layer, so build + runtime agree regardless of $HOME/user
# (rembg reads U2NET_HOME, not REMBG_HOME).
RUN python -c "from rembg import new_session; new_session('u2net'); print('rembg warm OK')"

COPY app.py .

EXPOSE 8000
CMD ["python", "app.py"]
