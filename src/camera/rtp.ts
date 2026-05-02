import { randomBytes } from 'crypto';

// Native RTP packetization for H.264 (RFC 6184) and G.711 µ-law (RFC 3551). Replaces
// the ffmpeg subprocess we used purely for codec-copy RTP packetization — the camera
// already gives us H.264 + G.711, so spawning ffmpeg per stream just to wrap the bytes
// in RTP headers was waste (one process, two pipes, two UDP socket pairs per camera).
// This module produces the same wire format consumers already speak.

const RTP_VERSION = 2;
const RTP_HEADER_LEN = 12;
export const PT_H264 = 96;
export const PT_PCMU = 0;
export const H264_CLOCK_HZ = 90000;
export const G711_CLOCK_HZ = 8000;

// RTCP Sender Report: 28 bytes, no report blocks (RC=0). RFC 3550 § 6.4.1.
const RTCP_SR_LEN = 28;
const RTCP_PT_SR = 200;
// NTP epoch (1900-01-01) precedes Unix epoch (1970-01-01) by this many seconds.
const NTP_UNIX_EPOCH_OFFSET_S = 2208988800;

export interface NtpTime {
    seconds: number;
    fraction: number;
}

// Wall-clock as an NTP 64-bit fixed-point timestamp (32-bit seconds since 1900,
// 32-bit fraction-of-second). Used in RTCP Sender Reports so receivers can map
// each track's RTP timeline back to a common wall-clock — required for A/V sync
// across two RTP streams that have independent random initial timestamps.
export function nowNtp(): NtpTime {
    const ms = Date.now();
    const seconds = Math.floor(ms / 1000) + NTP_UNIX_EPOCH_OFFSET_S;
    // 2^32 / 1000 = 4294967.296 — multiply ms-fraction by that to get the 32-bit
    // fraction word. Math.round to bias toward the nearest tick.
    const fraction = Math.round(((ms % 1000) / 1000) * 0x1_0000_0000);
    return { seconds: seconds >>> 0, fraction: fraction >>> 0 };
}

function writeSenderReport(
    ssrc: number,
    ntp: NtpTime,
    rtpTimestamp: number,
    packetCount: number,
    octetCount: number,
): Buffer {
    const buf = Buffer.allocUnsafe(RTCP_SR_LEN);
    // V=2, P=0, RC=0 → 0b10_0_00000 = 0x80
    buf[0] = RTP_VERSION << 6;
    buf[1] = RTCP_PT_SR;
    // Length in 32-bit words minus 1 → (28/4) - 1 = 6.
    buf.writeUInt16BE(6, 2);
    buf.writeUInt32BE(ssrc >>> 0, 4);
    buf.writeUInt32BE(ntp.seconds >>> 0, 8);
    buf.writeUInt32BE(ntp.fraction >>> 0, 12);
    buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
    buf.writeUInt32BE(packetCount >>> 0, 20);
    buf.writeUInt32BE(octetCount >>> 0, 24);
    return buf;
}

// FU-A fragmentation cutoff. We serve via RTSP/TCP-interleaved (no MTU constraint),
// but H.264 RTP receivers expect large NAL units to come as FU-A — fragmenting matches
// the wire shape they would see from any standard RTSP server. 1400 keeps headroom
// under a 1500-byte Ethernet MTU even though we never hit a real link.
const RTP_PAYLOAD_MTU = 1400;
// FU-A header overhead inside the RTP payload: 1 byte FU indicator + 1 byte FU header.
const FU_A_HEADER_OVERHEAD = 2;

// G.711 µ-law: 8 kHz mono, 1 byte per sample. 20 ms = 160 samples = 160 bytes per RTP
// packet, the standard sizing in RFC 3551.
const G711_SAMPLES_PER_PACKET = 160;

function writeRtpHeader(
    buf: Buffer,
    payloadType: number,
    seq: number,
    timestamp: number,
    ssrc: number,
    marker: boolean,
): void {
    buf[0] = RTP_VERSION << 6;
    buf[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
    buf.writeUInt16BE(seq & 0xffff, 2);
    buf.writeUInt32BE(timestamp >>> 0, 4);
    buf.writeUInt32BE(ssrc >>> 0, 8);
}

// Yields each NAL unit body (without the start code) found in an annex-b H.264 buffer.
// Handles both 3-byte (00 00 01) and 4-byte (00 00 00 01) start codes.
export function* annexbNalUnits(annexb: Buffer): IterableIterator<Buffer> {
    const len = annexb.length;
    let i = 0;
    while (i < len) {
        let start = -1;
        while (i + 2 < len) {
            if (annexb[i] === 0 && annexb[i + 1] === 0) {
                if (annexb[i + 2] === 1) {
                    start = i + 3;
                    break;
                }
                if (i + 3 < len && annexb[i + 2] === 0 && annexb[i + 3] === 1) {
                    start = i + 4;
                    break;
                }
            }
            i++;
        }
        if (start < 0) return;
        let end = len;
        for (let j = start; j + 2 < len; j++) {
            if (annexb[j] === 0 && annexb[j + 1] === 0) {
                if (annexb[j + 2] === 1 || (j + 3 < len && annexb[j + 2] === 0 && annexb[j + 3] === 1)) {
                    end = j;
                    break;
                }
            }
        }
        // Skip empty NALs (back-to-back start codes) defensively — they aren't valid in
        // well-formed bitstreams but a malformed part shouldn't poison the stream.
        if (end > start) yield annexb.subarray(start, end);
        i = end;
    }
}

export type RtpSink = (packet: Buffer) => void;

// One packetizer per stream session — owns the seq counter and SSRC. RTP requires both
// to be stable across all packets of a stream, with seq monotonically increasing.
export class H264RtpPacketizer {
    private seq: number;
    private packetCount = 0;
    private octetCount = 0;
    private lastTimestamp = 0;
    readonly ssrc: number;

    constructor() {
        this.seq = randomBytes(2).readUInt16BE(0);
        this.ssrc = randomBytes(4).readUInt32BE(0);
    }

    // Emits RTP packets for one access unit. All packets share `timestamp` (90 kHz),
    // and the marker bit is set on the last packet of the AU per RFC 6184 § 5.1. Caller
    // typically passes one annex-b buffer per video part = one AU.
    packetize(annexb: Buffer, timestamp: number, sink: RtpSink): void {
        const nals: Buffer[] = [];
        for (const nal of annexbNalUnits(annexb)) nals.push(nal);
        if (nals.length === 0) return;

        for (let i = 0; i < nals.length; i++) {
            const nal = nals[i];
            const isLastNal = i === nals.length - 1;

            if (nal.length <= RTP_PAYLOAD_MTU) {
                const pkt = Buffer.allocUnsafe(RTP_HEADER_LEN + nal.length);
                writeRtpHeader(pkt, PT_H264, this.seq++, timestamp, this.ssrc, isLastNal);
                nal.copy(pkt, RTP_HEADER_LEN);
                sink(pkt);
                this.packetCount++;
                this.octetCount = (this.octetCount + nal.length) >>> 0;
                continue;
            }

            // FU-A: split nal[0]'s F+NRI bits into the FU indicator (with type=28), and
            // its 5-bit NAL type into the FU header along with start/end markers. The
            // payload is nal.subarray(1) — the original NAL header byte is reconstructed
            // by the receiver from FU indicator NRI + FU header type.
            const nalHeader = nal[0];
            const fuIndicator = (nalHeader & 0xe0) | 28;
            const fuTypeBits = nalHeader & 0x1f;
            const payload = nal.subarray(1);
            const chunkSize = RTP_PAYLOAD_MTU - FU_A_HEADER_OVERHEAD;
            let offset = 0;
            while (offset < payload.length) {
                const remaining = payload.length - offset;
                const take = Math.min(chunkSize, remaining);
                const isFirstFu = offset === 0;
                const isLastFu = take === remaining;
                const fuHeader = (isFirstFu ? 0x80 : 0) | (isLastFu ? 0x40 : 0) | fuTypeBits;
                const pkt = Buffer.allocUnsafe(RTP_HEADER_LEN + FU_A_HEADER_OVERHEAD + take);
                writeRtpHeader(pkt, PT_H264, this.seq++, timestamp, this.ssrc, isLastNal && isLastFu);
                pkt[RTP_HEADER_LEN] = fuIndicator;
                pkt[RTP_HEADER_LEN + 1] = fuHeader;
                payload.copy(pkt, RTP_HEADER_LEN + FU_A_HEADER_OVERHEAD, offset, offset + take);
                sink(pkt);
                this.packetCount++;
                this.octetCount = (this.octetCount + FU_A_HEADER_OVERHEAD + take) >>> 0;
                offset += take;
            }
        }
        this.lastTimestamp = timestamp >>> 0;
    }

    // Build an RTCP Sender Report describing the latest emission. `ntp` should be sampled
    // close to the moment of the SR's wire emission so the NTP↔RTP timestamp pair stays
    // accurate. Returns undefined when no packets have been emitted yet — receivers can
    // tolerate a missing first SR, and emitting one with all zeros confuses jitter math.
    senderReport(ntp: NtpTime): Buffer | undefined {
        if (this.packetCount === 0) return;
        return writeSenderReport(this.ssrc, ntp, this.lastTimestamp, this.packetCount, this.octetCount);
    }
}

// G.711 µ-law packetizer — chunks a µ-law byte stream into 20 ms RTP packets. The caller
// supplies the timestamp of the FIRST sample in `mulaw`; the packetizer advances by
// sample count internally to keep packet-to-packet timing exact regardless of how the
// camera batched samples into multipart parts. Returns the next-sample timestamp so the
// caller can chain across parts if it wants sample-accurate timing.
export class G711RtpPacketizer {
    private seq: number;
    private packetCount = 0;
    private octetCount = 0;
    private lastTimestamp = 0;
    readonly ssrc: number;

    constructor() {
        this.seq = randomBytes(2).readUInt16BE(0);
        this.ssrc = randomBytes(4).readUInt32BE(0);
    }

    packetize(mulaw: Buffer, timestampStart: number, sink: RtpSink): number {
        let offset = 0;
        let ts = timestampStart >>> 0;
        while (offset < mulaw.length) {
            const take = Math.min(G711_SAMPLES_PER_PACKET, mulaw.length - offset);
            const pkt = Buffer.allocUnsafe(RTP_HEADER_LEN + take);
            writeRtpHeader(pkt, PT_PCMU, this.seq++, ts, this.ssrc, false);
            mulaw.copy(pkt, RTP_HEADER_LEN, offset, offset + take);
            sink(pkt);
            this.packetCount++;
            this.octetCount = (this.octetCount + take) >>> 0;
            this.lastTimestamp = ts;
            ts = (ts + take) >>> 0;
            offset += take;
        }
        return ts;
    }

    senderReport(ntp: NtpTime): Buffer | undefined {
        if (this.packetCount === 0) return;
        return writeSenderReport(this.ssrc, ntp, this.lastTimestamp, this.packetCount, this.octetCount);
    }
}
