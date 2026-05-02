class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.framesPerChunk = 16000;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let index = 0; index < input.length; index += 1) {
      this.buffer.push(input[index]);
    }

    while (this.buffer.length >= this.framesPerChunk) {
      const samples = this.buffer.splice(0, this.framesPerChunk);
      const pcm = new Int16Array(samples.length);

      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
