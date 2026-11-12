# Hugging Face Docker Space runtime for Content Factory
FROM mambaorg/micromamba:1.5.8

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git libsndfile1 fonts-dejavu-core ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

USER $MAMBA_USER
WORKDIR /app

COPY --chown=$MAMBA_USER:$MAMBA_USER environment.yml /app/environment.yml
RUN micromamba env create -f /app/environment.yml

RUN git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git /opt/moss
RUN micromamba run -n content-factory pip install --no-cache-dir -r /opt/moss/requirements.txt \
    && micromamba run -n content-factory pip install --no-cache-dir -e /opt/moss \
    && micromamba run -n content-factory pip install --no-cache-dir faster-whisper pillow requests httpx

COPY --chown=$MAMBA_USER:$MAMBA_USER gateway.py /app/gateway.py
COPY --chown=$MAMBA_USER:$MAMBA_USER start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/data/.cache/huggingface
ENV TTS_INTERNAL_URL=http://127.0.0.1:18083
ENV CPU_THREADS=2
ENV ASR_MODEL_SIZE=base
EXPOSE 7860
CMD ["/app/start.sh"]
