/**
 * Synthetic CAF/LPCM file builder for the transcode tests.
 *
 * Produces the exact byte layout `AVAudioRecorder` writes for the iOS voice
 * strategy: the 8-byte `caff` header, a 32-byte `desc` chunk, and a `data`
 * chunk whose int64 size is `-1` while the recorder is mid-write (the live
 * snapshot case) or the real payload size once finalized. All header fields are
 * big-endian per the CAF spec; the PCM payload is little-endian int16 (matching
 * `linearPCMIsBigEndian: false`).
 */

export interface CafFixtureOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerChannel?: number;
  /** `true` (default) = mid-recording: data chunk size written as -1. */
  openEnded?: boolean;
  /** Flip to build an unsupported big-endian/float CAF for rejection tests. */
  littleEndian?: boolean;
  float?: boolean;
}

export function buildCafFixture(pcm: Uint8Array, options: CafFixtureOptions = {}): Uint8Array {
  const {
    sampleRate = 16000,
    channels = 1,
    bitsPerChannel = 16,
    openEnded = true,
    littleEndian = true,
    float = false,
  } = options;

  const total = 8 + 12 + 32 + 12 + 4 + pcm.byteLength;
  const caf = new Uint8Array(total);
  const view = new DataView(caf.buffer);
  let at = 0;

  const fourCC = (cc: string) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(at + i, cc.charCodeAt(i));
    at += 4;
  };
  const u32 = (value: number) => {
    view.setUint32(at, value);
    at += 4;
  };
  const i64 = (value: number | null) => {
    if (value === null) {
      u32(0xffffffff); // -1: "until EOF" (mid-recording)
      u32(0xffffffff);
    } else {
      u32(Math.floor(value / 0x100000000));
      u32(value >>> 0);
    }
  };

  // File header
  fourCC('caff');
  view.setUint16(at, 1); // version
  view.setUint16(at + 2, 0); // flags
  at += 4;

  // desc chunk
  fourCC('desc');
  i64(32);
  view.setFloat64(at, sampleRate);
  at += 8;
  fourCC('lpcm');
  u32((float ? 1 : 0) | (littleEndian ? 2 : 0)); // format flags
  u32((bitsPerChannel / 8) * channels); // bytes per packet
  u32(1); // frames per packet
  u32(channels);
  u32(bitsPerChannel);

  // data chunk: uint32 edit count + PCM
  fourCC('data');
  i64(openEnded ? null : 4 + pcm.byteLength);
  u32(0); // edit count
  caf.set(pcm, at);

  return caf;
}
