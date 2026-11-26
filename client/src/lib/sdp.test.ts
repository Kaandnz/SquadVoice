import { describe, expect, it } from 'vitest';
import {
  isInitiatorPeer,
  isPolitePeer,
  sanitizeRtcPayload,
  sdpSessionId,
  tuneOpusSdp,
} from './sdp';

describe('sdpSessionId', () => {
  it('reads the origin session id regardless of version and line endings', () => {
    const sdp = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-'].join('\r\n');
    expect(sdpSessionId(sdp)).toBe('4611731400430051336');
    expect(sdpSessionId(sdp.replace(' 2 IN', ' 7 IN'))).toBe('4611731400430051336');
    expect(sdpSessionId(sdp.split('\r\n').join('\n'))).toBe('4611731400430051336');
  });

  it('returns null when there is no origin line', () => {
    expect(sdpSessionId('v=0\r\ns=-')).toBeNull();
    expect(sdpSessionId(undefined)).toBeNull();
  });
});

describe('isPolitePeer & isInitiatorPeer', () => {
  it('is deterministic and asymmetric for any two distinct IDs', () => {
    const a = 'user-a';
    const b = 'user-b';
    expect(isPolitePeer(a, b)).toBe(true);
    expect(isPolitePeer(b, a)).toBe(false);
    expect(isInitiatorPeer(a, b)).toBe(false);
    expect(isInitiatorPeer(b, a)).toBe(true);
  });
});

describe('sanitizeRtcPayload', () => {
  it('strips undefined fields from RTCIceCandidateInit payloads', () => {
    const raw = {
      candidate: 'candidate:1 1 UDP 123 1.2.3.4 5555 typ srflx',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: undefined,
    };
    const cleaned = sanitizeRtcPayload(raw);
    expect('usernameFragment' in cleaned).toBe(false);
    expect(cleaned.sdpMid).toBe('0');
  });
});

describe('tuneOpusSdp', () => {
  it('updates existing opus fmtp line with target bitrate and stereo', () => {
    const sampleSdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=rtpmap:0 PCMU/8000',
    ].join('\r\n');

    const tuned = tuneOpusSdp(sampleSdp, {
      bitrateKbps: 128,
      stereo: true,
      dtx: false,
      ptime: 20,
    });

    expect(tuned).toContain('maxaveragebitrate=128000');
    expect(tuned).toContain('stereo=1');
    expect(tuned).toContain('sprop-stereo=1');
    expect(tuned).toContain('usedtx=0');
    expect(tuned).toContain('useinbandfec=1');
    expect(tuned).toContain('a=ptime:20');
    expect(tuned).toContain('a=rtpmap:0 PCMU/8000');
  });

  it('inserts an opus fmtp line when missing', () => {
    const sampleSdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
    ].join('\n');

    const tuned = tuneOpusSdp(sampleSdp, {
      bitrateKbps: 96,
      stereo: false,
    });

    expect(tuned).toContain('a=fmtp:111 ');
    expect(tuned).toContain('maxaveragebitrate=96000');
    expect(tuned).toContain('stereo=0');
  });

  it('leaves non-opus SDP unchanged', () => {
    const videoOnly = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000'].join('\n');
    expect(tuneOpusSdp(videoOnly, { bitrateKbps: 96, stereo: false })).toBe(videoOnly);
  });
});
