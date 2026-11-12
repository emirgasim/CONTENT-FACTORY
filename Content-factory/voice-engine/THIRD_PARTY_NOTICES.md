# Third-party notices

## MOSS-TTS-Nano

The voice engine clones the official source at https://github.com/OpenMOSS/MOSS-TTS-Nano during the Docker build. The uploaded source archive was reviewed; it includes an Apache License 2.0 license file. The ONNX weight repositories identify their license as Apache-2.0:

- https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX
- https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX

Model weights are downloaded at first engine startup and are not stored in this Git repository.

## Faster-Whisper

Speech transcription uses faster-whisper: https://github.com/SYSTRAN/faster-whisper. The package and its model files are installed/downloaded by the engine environment.

## Wikimedia Commons

The renderer searches Wikimedia Commons and records per-file source and license information. Every generated video is accompanied by `sources-and-licenses.txt`. The user is responsible for reviewing individual attribution and share-alike requirements before publishing.
