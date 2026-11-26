export interface OpusTuneOptions {
  bitrateKbps: number;
  stereo: boolean;
  dtx?: boolean;
  ptime?: number;
}

/**
 * Determines polite peer deterministically during Perfect Negotiation
 * so simultaneous offer collisions never deadlock.
 */
export function isPolitePeer(myUserId: string, remoteUserId: string): boolean {
  return myUserId < remoteUserId;
}

/**
 * Complementary single-initiator rule: only the impolite peer (larger ID)
 * sends the initial offer so simultaneous join glares never happen.
 */
export function isInitiatorPeer(myUserId: string, remoteUserId: string): boolean {
  return myUserId > remoteUserId;
}

/**
 * Strips undefined values recursively so signaling payloads never fail
 * Firebase Realtime Database serialization.
 */
export function sanitizeRtcPayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Rewrites the Opus a=fmtp line in a WebRTC SDP to enforce high-quality
 * gaming/music audio (higher bitrate, FEC, optional stereo, low ptime).
 */
export function tuneOpusSdp(sdp: string, opts: OpusTuneOptions): string {
  const newline = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  let opusPayloadType: string | null = null;
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i);
    if (match) {
      opusPayloadType = match[1];
      break;
    }
  }

  if (!opusPayloadType) {
    return sdp;
  }

  const maxAverageBitrate = Math.max(24000, Math.min(510000, Math.round(opts.bitrateKbps * 1000)));
  const stereoVal = opts.stereo ? '1' : '0';
  const dtxVal = opts.dtx === false ? '0' : '1';
  const ptimeVal = String(opts.ptime ?? 20);

  const fmtpPrefix = `a=fmtp:${opusPayloadType} `;
  let foundFmtp = false;

  const updatedLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(fmtpPrefix)) {
      foundFmtp = true;
      const rawParams = line.slice(fmtpPrefix.length).trim();
      const paramMap = new Map<string, string>();
      for (const part of rawParams.split(';')) {
        const clean = part.trim();
        if (!clean) continue;
        const eqIdx = clean.indexOf('=');
        if (eqIdx > 0) {
          paramMap.set(clean.slice(0, eqIdx).trim(), clean.slice(eqIdx + 1).trim());
        }
      }

      paramMap.set('minptime', '10');
      paramMap.set('useinbandfec', '1');
      paramMap.set('maxaveragebitrate', String(maxAverageBitrate));
      paramMap.set('stereo', stereoVal);
      paramMap.set('sprop-stereo', stereoVal);
      paramMap.set('usedtx', dtxVal);

      const serialized = Array.from(paramMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
      updatedLines.push(`${fmtpPrefix}${serialized}`);
      continue;
    }

    updatedLines.push(line);

    if (line.startsWith(`a=rtpmap:${opusPayloadType} `) && !foundFmtp) {
      const hasLaterFmtp = lines.some((l) => l.startsWith(fmtpPrefix));
      if (!hasLaterFmtp) {
        foundFmtp = true;
        updatedLines.push(
          `${fmtpPrefix}minptime=10;useinbandfec=1;maxaveragebitrate=${maxAverageBitrate};stereo=${stereoVal};sprop-stereo=${stereoVal};usedtx=${dtxVal}`,
        );
      }
    }
  }

  const finalLines: string[] = [];
  let inAudioSection = false;
  let audioHasPtime = false;
  for (let i = 0; i < updatedLines.length; i += 1) {
    const line = updatedLines[i];
    if (line.startsWith('m=audio ')) {
      inAudioSection = true;
      audioHasPtime = false;
      finalLines.push(line);
      continue;
    }
    if (line.startsWith('m=') && !line.startsWith('m=audio ')) {
      if (inAudioSection && !audioHasPtime) {
        finalLines.push(`a=ptime:${ptimeVal}`);
      }
      inAudioSection = false;
    }
    if (inAudioSection && line.startsWith('a=ptime:')) {
      audioHasPtime = true;
      finalLines.push(`a=ptime:${ptimeVal}`);
      continue;
    }
    finalLines.push(line);
  }
  if (inAudioSection && !audioHasPtime) {
    finalLines.push(`a=ptime:${ptimeVal}`);
  }

  return finalLines.join(newline);
}
