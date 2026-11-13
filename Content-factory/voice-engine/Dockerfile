# Hugging Face Docker Space runtime for Content Factory
FROM mambaorg/micromamba:1.5.8

USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libsndfile1 fonts-dejavu-core ca-certificates curl \
    && mkdir -p /opt/moss /home/mambauser/.cache/huggingface \
    && chown -R mambauser:mambauser /opt/moss /home/mambauser/.cache \
    && rm -rf /var/lib/apt/lists/*

USER $MAMBA_USER
WORKDIR /app

COPY --chown=$MAMBA_USER:$MAMBA_USER environment.yml /app/environment.yml
RUN micromamba env create -f /app/environment.yml

ARG MOSS_COMMIT=8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb
RUN git init /opt/moss && cd /opt/moss && git remote add origin https://github.com/OpenMOSS/MOSS-TTS-Nano.git && git fetch --depth 1 origin $MOSS_COMMIT && git checkout FETCH_HEAD

# Install CPU-only PyTorch first; upstream app_onnx imports shared app utilities.
RUN micromamba run -n content-factory pip install --no-cache-dir torch==2.7.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cpu \
    && micromamba run -n content-factory pip install --no-cache-dir -r /opt/moss/requirements.txt \
    && micromamba run -n content-factory pip install --no-cache-dir -e /opt/moss \
    && micromamba run -n content-factory pip install --no-cache-dir faster-whisper pillow requests httpx transformers==4.51.3 safetensors

COPY --chown=$MAMBA_USER:$MAMBA_USER gateway.py /app/gateway.py
COPY --chown=$MAMBA_USER:$MAMBA_USER editing_agent.py /app/editing_agent.py
COPY --chown=$MAMBA_USER:$MAMBA_USER start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/home/mambauser/.cache/huggingface
ENV TTS_INTERNAL_URL=http://127.0.0.1:18083
ENV CPU_THREADS=2
ENV ASR_MODEL_SIZE=base
EXPOSE 7860
CMD ["/app/start.sh"]
