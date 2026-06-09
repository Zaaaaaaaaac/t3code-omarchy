/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    const samples = new Float32Array(channel.length);
    samples.set(channel);
    this.port.postMessage({ samples, sampleRate }, [samples.buffer]);
    return true;
  }
}

registerProcessor("voice-capture", VoiceCaptureProcessor);
